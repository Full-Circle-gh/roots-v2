#!/usr/bin/env node
/**
 * Before/after equivalence for the SECOND transaction conversion batch
 * (decisions §24, Path A step 3): ten inline route transactions in
 * routes/retail.js moved from better-sqlite3's db.transaction() onto
 * withTransaction.
 *
 *   node scripts/test_tx_conversion_batch2.js
 *
 * THE TEN, and the thing each one is here to prove:
 *
 *   DELETE /media/folders/:id          two statements, one unit
 *   POST   /media/bulk-move            a counter accumulated in the closure
 *   POST   /media/bulk-delete          same, on a DELETE
 *   POST   /media/bulk-tag             a READ inside the body feeding its UPDATE
 *   POST   /categories/reorder         a transaction ARGUMENT became a closure
 *   POST   /products/reorder           a SELECT that stays OUTSIDE the body
 *   PATCH  /categories/:id             a UNIQUE violation must stay a 400
 *   POST   /polls                      the body RETURNS a value the response needs
 *   PUT    /polls/:id                  the largest body; a swallow-and-500 catch
 *   PUT    /config                     the storefront_config upsert loop
 *
 * WHAT IS COMPARED. Not "it still runs". Each route is exercised in BOTH forms —
 * the pre-conversion one and the converted one — against identical fixtures on
 * the same schema, and the two are held equal on everything observable: the
 * HTTP response (status and body, via a recording res), every row left in every
 * touched table, the error thrown and its properties, whether logActivity fired,
 * and the state left behind after a mid-transaction failure.
 *
 * HOW THE TWO FORMS ARE BUILT, STATED PLAINLY SO NOTHING IS OVERCLAIMED. Each
 * transaction body is written ONCE, as a function taking the handle its
 * statements run on — because that is precisely what the conversion did to it:
 * the SQL is byte-identical in the diff, `tdb()` became the handle passed in.
 * The old form runs that body against the raw handle inside db.transaction();
 * the new form runs it against the handle withTransaction hands in. What IS
 * written out twice is every surrounding handler — the try/catch, the response,
 * the logActivity call — because the await's placement inside or outside a catch
 * is the one thing this conversion can get wrong silently, and it has to be
 * visible here to be tested.
 *
 * That the SQL did not change is established by reading the diff, not by this
 * suite; a suite that compares a copy to itself proves only that copying works.
 * What this suite adds on top is a STATIC check (section 12) that no converted
 * body still reaches for tdb() — the one new way a body can be wrong that no
 * amount of row-comparison would catch, because on SQLite tdb() and the handle
 * are the same object and every such test would pass anyway.
 *
 * THE SCHEMA IS THE REAL ONE, rebuilt by the shared harness — retail_media,
 * retail_media_folders, retail_polls, retail_poll_options and storefront_config
 * out of database.js, `categories` out of schema.sql (its CREATE lives there,
 * and its UNIQUE(kind,name) is what section 7 depends on), and store_products
 * through the boot-time fork rule, since it has no literal CREATE anywhere.
 *
 * ONE DRIVER LIMITATION, STATED RATHER THAN HIDDEN. The pre-conversion form
 * calls db.transaction(), which node:sqlite does not have. On that driver the
 * "old" form is a manual BEGIN/COMMIT reference — the same statements
 * better-sqlite3 issues — and the run says so in its footer. Only a
 * better-sqlite3 run compares against the REAL old implementation, which is why
 * this suite is also run on the box.
 *
 * TO PROVE THE SUITE CAN FAIL:  TX_CONV2_SABOTAGE=1 node scripts/test_tx_conversion_batch2.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { openTablesDb, addTables, addForkedStoreProducts, driver } =
  require('./test-support/memory-db');
const { withTransaction, transactionDepth } = require('../lib/db-transaction');

const SABOTAGE = process.env.TX_CONV2_SABOTAGE === '1';
const ROOT = path.join(__dirname, '..');
const DB_SRC = fs.readFileSync(path.join(ROOT, 'database.js'), 'utf8');
const SCHEMA_SRC = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
const RETAIL_SRC = fs.readFileSync(path.join(ROOT, 'routes', 'retail.js'), 'utf8');

const DB_TABLES = ['retail_media', 'retail_media_folders', 'retail_polls',
  'retail_poll_options', 'storefront_config'];

/**
 * How many unconverted db.transaction() blocks are left in routes/retail.js,
 * taken from the SAME source §24 quotes.
 *
 * WHY THIS IS NOT JUST A REGEX. It used to be, and it was wrong by one: grep
 * matches a COMMENT that mentions `tdb().transaction()`, so the test asserted 45
 * while the figure of record was 44. A guard that disagrees with the documented
 * count is worse than no guard, because the next person has to work out which of
 * the two lied.
 *
 * PRIMARY: scripts/diagnose_async_conversion_scope.js, which §24 names as the
 * authority for these counts. It parses an AST, so a comment cannot inflate it.
 *
 * IT RETURNS null RATHER THAN GUESSING. That script needs `espree`, which
 * arrives with the `eslint` devDependency and is therefore ABSENT on the
 * production box, which installs production dependencies only — and this suite
 * has to run on the box, the only machine with the native better-sqlite3 binding
 * and so the only place the pre-conversion form runs for real.
 *
 * The obvious answer is a regex fallback. IT WAS TRIED AND IT WAS WRONG: strip
 * comments and string literals with regexes and an apostrophe inside a comment
 * ("don't") unbalances the single-quote pass, which then swallows real code — it
 * silently returned 0 against an actual 39. That is precisely the hand-rolled
 * source-scanner failure this record keeps meeting, and shipping a second one to
 * guard against the first would be absurd. So where the authority cannot run,
 * this check reports itself as SKIPPED rather than asserting a number nothing
 * verified. A skipped check is honest; a guessed one is a liability.
 */
function countTransactionsAuthoritative() {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath,
    [path.join(ROOT, 'scripts', 'diagnose_async_conversion_scope.js'), '--file', 'routes/retail.js'],
    { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;          // espree missing, or it failed
  const section = r.stdout.split('[3] db.transaction() BLOCKS')[1];
  if (!section) return null;
  const m = /runtime total:\s*(\d+)/.exec(section);
  return m ? Number(m[1]) : null;
}

function openDb() {
  const db = openTablesDb(DB_SRC, DB_TABLES);
  addTables(db, SCHEMA_SRC, DB_SRC, ['categories']);
  addForkedStoreProducts(db, SCHEMA_SRC, DB_SRC);
  return db;
}

// Whether the pre-conversion form can be run for real on this driver.
const REAL_OLD = typeof openDb().transaction === 'function';

let pass = 0, fail = 0;
async function it(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
}

// A stand-in for better-sqlite3's db.transaction() on drivers that lack it —
// the same BEGIN/COMMIT/ROLLBACK it issues, so the "old" column of the
// comparison still means something on node:sqlite.
function legacyTransaction(db, fn) {
  return (...args) => {
    db.exec('BEGIN');
    try { const r = fn(...args); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch { /* already unwound */ } throw e; }
  };
}
const makeOldTx = (db, fn) => (REAL_OLD ? db.transaction(fn) : legacyTransaction(db, fn));

/** Run a body the OLD way: db.transaction(), statements on the raw handle. */
const oldRun = (db, body, ...args) => makeOldTx(db, () => body(db, ...args))();
/** Run a body the NEW way: withTransaction, statements on the handle handed in. */
const newRun = (db, body, ...args) => withTransaction(db, (tx) => body(tx, ...args));

/**
 * A res that records what the handler answered instead of writing a socket.
 *
 * Marked, because several handlers end in `return res.status(400).json(...)` —
 * the real early-return shape, which hands the res itself back as the handler's
 * return value. Two recorders are different objects carrying functions, so
 * comparing them directly would fail on identity rather than on behaviour; the
 * marker lets assertSame normalise that away and compare what was ANSWERED.
 */
function mkRes() {
  const rec = { status: 200, body: undefined, sends: 0 };
  const res = {
    __recordingRes: true,
    status(c) { rec.status = c; return res; },
    json(b) { rec.body = b; rec.sends++; return res; },
  };
  return { res, rec };
}
const normReturn = (v) => (v && v.__recordingRes ? '<res>' : v);

/** A logActivity stand-in that records whether — and with what — it fired. */
function mkLog() {
  const calls = [];
  return { log: (...a) => calls.push(a), calls };
}

/** Everything in one table, ordered, as a comparable snapshot. */
const snap = (db, sql, ...p) => JSON.parse(JSON.stringify(db.prepare(sql).all(...p)));

/** Run `fn` and report what happened, without letting a throw escape. */
async function attempt(fn) {
  try { return { value: await fn(), threw: null }; }
  catch (e) { return { value: undefined, threw: e }; }
}

/**
 * The core comparison: seed two fresh databases identically, run the old form
 * against one and the new form against the other, and hand both back with their
 * snapshots so a test can assert they are indistinguishable.
 */
async function bothForms({ seed, runOld, runNew, snapshot }) {
  const dbOld = openDb(); seed(dbOld);
  const dbNew = openDb(); seed(dbNew);
  const o = mkRes(), n = mkRes();
  const lo = mkLog(), ln = mkLog();
  const ro = await attempt(() => runOld(dbOld, o.res, lo.log));
  const rn = await attempt(() => runNew(dbNew, n.res, ln.log));
  return {
    old: { db: dbOld, res: o.rec, log: lo.calls, ...ro, snap: snapshot(dbOld) },
    neu: { db: dbNew, res: n.rec, log: ln.calls, ...rn, snap: snapshot(dbNew) },
  };
}

/** Assert the two forms are indistinguishable on everything observable. */
function assertSame(r, what) {
  assert.deepStrictEqual(r.neu.res, r.old.res, `${what}: response differs`);
  assert.deepStrictEqual(r.neu.snap, r.old.snap, `${what}: rows differ`);
  assert.deepStrictEqual(r.neu.log, r.old.log, `${what}: activity log differs`);
  assert.deepStrictEqual(normReturn(r.neu.value), normReturn(r.old.value),
    `${what}: return value differs`);
  assert.strictEqual(!!r.neu.threw, !!r.old.threw, `${what}: one threw and the other did not`);
  if (r.old.threw) {
    assert.strictEqual(r.neu.threw.message, r.old.threw.message, `${what}: error message differs`);
    assert.strictEqual(r.neu.threw.code, r.old.threw.code, `${what}: error code differs`);
  }
}

// A body can be told to fail partway through, at the same point in both forms.
class Boom extends Error {
  constructor() { super('boom'); this.code = 'TEST_BOOM'; this.detail = 'carried'; }
}

// ══════════════════════════════════════════════════════════════════════════
// The ten bodies. Each takes the handle its statements run on — the whole of
// what the conversion changed. SQL copied from routes/retail.js.
// ══════════════════════════════════════════════════════════════════════════

const SQL = {
  unsortFolder: 'UPDATE retail_media SET folder_id = NULL WHERE folder_id = ?',
  delFolder: 'DELETE FROM retail_media_folders WHERE id = ?',
  moveMedia: 'UPDATE retail_media SET folder_id = ? WHERE id = ?',
  delMedia: 'DELETE FROM retail_media WHERE id = ?',
  getTags: 'SELECT tags FROM retail_media WHERE id = ?',
  setTags: 'UPDATE retail_media SET tags = ? WHERE id = ?',
  catSort: "UPDATE categories SET sort_order = ? WHERE id = ? AND kind = 'product'",
  prodSort: 'UPDATE store_products SET sort_order = ? WHERE id = ?',
  renameCat: 'UPDATE categories SET name = ? WHERE id = ?',
  repointProducts: 'UPDATE store_products SET category = ? WHERE category = ?',
  insPoll: `INSERT INTO retail_polls
        (question_en, question_cn, explainer_en, explainer_cn, category_en, category_cn,
         status, closes_at, reward_points, is_featured, sort_order, display_min_total)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  insOpt: `INSERT INTO retail_poll_options (poll_id, label_en, label_cn, color_hex, image_url, sort_order)
       VALUES (?,?,?,?,?,?)`,
  upsertConfig: `INSERT INTO storefront_config (key, value_json, updated_at, updated_by)
     VALUES (?, ?, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = CURRENT_TIMESTAMP,
       updated_by = excluded.updated_by`,
};

// parseTags / normalizeTagList are pure in routes/retail.js — no handle, no db.
const parseTags = (v) => {
  if (!v) return [];
  try { const a = JSON.parse(v); return Array.isArray(a) ? a.map(s => String(s).trim().toLowerCase()).filter(Boolean) : []; }
  catch { return []; }
};
const normalizeTagList = (arr) => {
  if (!Array.isArray(arr)) return [];
  const seen = new Set(); const out = [];
  for (const t of arr) {
    const k = String(t || '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40);
    if (k && !seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out.slice(0, 20);
};

const bodyFolderDelete = (h, id, hook) => {
  h.prepare(SQL.unsortFolder).run(id);
  if (hook) hook();
  h.prepare(SQL.delFolder).run(id);
};

const bodyBulkMove = (h, ids, folderId, counter, hook) => {
  const stmt = h.prepare(SQL.moveMedia);
  for (const id of ids) { if (hook) hook(id); counter.moved += stmt.run(folderId, id).changes; }
};

const bodyBulkDelete = (h, ids, counter, hook) => {
  const stmt = h.prepare(SQL.delMedia);
  for (const id of ids) { if (hook) hook(id); counter.deleted += stmt.run(id).changes; }
};

const bodyBulkTag = (h, ids, add, remove, hook) => {
  const get = h.prepare(SQL.getTags);
  const upd = h.prepare(SQL.setTags);
  for (const id of ids) {
    const row = get.get(id); if (!row) continue;
    if (hook) hook(id);
    const cur = new Set(parseTags(row.tags));
    for (const t of add) cur.add(t);
    for (const t of remove) cur.delete(t);
    upd.run(JSON.stringify(normalizeTagList([...cur])), id);
  }
};

const bodyCatReorder = (h, ordered, hook) => {
  const stmt = h.prepare(SQL.catSort);
  ordered.forEach((id, i) => { if (hook) hook(i); stmt.run(i + 1, id); });
};

const bodyProdReorder = (h, ids, slots, hook) => {
  const stmt = h.prepare(SQL.prodSort);
  ids.forEach((id, i) => { if (hook) hook(i); stmt.run(slots[i], id); });
};

const bodyCatRename = (h, id, name, oldName, hook) => {
  h.prepare(SQL.renameCat).run(name, id);
  if (hook) hook();
  h.prepare(SQL.repointProducts).run(name, oldName);
};

const bodyPollCreate = (h, b, options, hook) => {
  const r = h.prepare(SQL.insPoll).run(
    b.question_en, b.question_cn || null, null, null, null, null,
    b.status || 'draft', null, 5, 0, 0, 0);
  const newPollId = r.lastInsertRowid;
  if (hook) hook();
  const insOpt = h.prepare(SQL.insOpt);
  for (const o of options) {
    insOpt.run(newPollId, o.label_en, o.label_cn || null, null, null, o.sort_order);
  }
  return newPollId;
};

// The in-place branch of PUT /polls/:id — the one that preserves vote counts,
// adds new options, and refuses to delete an option that has votes.
const bodyPollUpdate = (h, id, updates, incomingOptions, hook) => {
  if (Object.keys(updates).length) {
    const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    h.prepare(`UPDATE retail_polls SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(...Object.values(updates), id);
  }
  if (hook) hook();
  if (incomingOptions) {
    const existingIds = new Set(h.prepare('SELECT id FROM retail_poll_options WHERE poll_id = ?').all(id).map(r => r.id));
    const seenIds = new Set();
    const upd = h.prepare(
      `UPDATE retail_poll_options SET
             label_en = ?, label_cn = ?, color_hex = ?, image_url = ?, sort_order = ?
           WHERE id = ? AND poll_id = ?`);
    const ins = h.prepare(SQL.insOpt);
    incomingOptions.forEach((o, i) => {
      const labelEn = String(o?.label_en || '').trim().slice(0, 60);
      if (!labelEn) return;
      const oid = parseInt(o?.id, 10);
      if (oid && existingIds.has(oid)) { upd.run(labelEn, null, null, null, i, oid, id); seenIds.add(oid); }
      else { ins.run(id, labelEn, null, null, null, i); }
    });
    for (const oldId of existingIds) {
      if (!seenIds.has(oldId)) {
        const votes = h.prepare('SELECT votes FROM retail_poll_options WHERE id = ?').get(oldId)?.votes || 0;
        if (votes > 0) continue;
        h.prepare('DELETE FROM retail_poll_options WHERE id = ?').run(oldId);
      }
    }
  }
};

const bodyConfigWrite = (h, entries, userId, hook) => {
  const upsert = h.prepare(SQL.upsertConfig);
  for (const [k, v] of entries) { if (hook) hook(k); upsert.run(k, JSON.stringify(v), userId); }
};

// ══════════════════════════════════════════════════════════════════════════
// Fixtures
// ══════════════════════════════════════════════════════════════════════════

function seedMedia(db) {
  db.exec(`INSERT INTO retail_media_folders (id, name) VALUES (1,'Shots'),(2,'Labels')`);
  const ins = db.prepare(
    `INSERT INTO retail_media (id, filename, mime_type, size_bytes, data, folder_id, tags)
     VALUES (?,?,?,?,?,?,?)`);
  ins.run(10, 'a.png', 'image/png', 4, 'AAAA', 1, JSON.stringify(['hero']));
  ins.run(11, 'b.png', 'image/png', 4, 'BBBB', 1, JSON.stringify(['hero', 'old']));
  ins.run(12, 'c.png', 'image/png', 4, 'CCCC', 2, JSON.stringify([]));
}
const MEDIA_SNAP = (db) => ({
  media: snap(db, 'SELECT id, folder_id, tags FROM retail_media ORDER BY id'),
  folders: snap(db, 'SELECT id, name FROM retail_media_folders ORDER BY id'),
});

function seedCatalogue(db) {
  db.exec(`INSERT INTO categories (id, kind, name, sort_order) VALUES
    (1,'product','Tofu',3),(2,'product','Tempeh',1),(3,'product','Seitan',2),
    (4,'recipe','Tofu',9)`);
  const ins = db.prepare('INSERT INTO store_products (id, name_en, category, sort_order) VALUES (?,?,?,?)');
  ins.run(100, 'Silken', 'Tofu', 30);
  ins.run(101, 'Firm', 'Tofu', 10);
  ins.run(102, 'Strips', 'Tempeh', 20);
}
const CATALOGUE_SNAP = (db) => ({
  cats: snap(db, 'SELECT id, kind, name, sort_order FROM categories ORDER BY id'),
  prods: snap(db, 'SELECT id, category, sort_order FROM store_products ORDER BY id'),
});

function seedPolls(db) {
  db.exec(`INSERT INTO retail_polls (id, question_en, status, sort_order) VALUES (7,'Which next?','open',0)`);
  const ins = db.prepare(
    'INSERT INTO retail_poll_options (id, poll_id, label_en, sort_order, votes) VALUES (?,?,?,?,?)');
  ins.run(70, 7, 'Miso', 0, 4);     // has votes — must survive a drop
  ins.run(71, 7, 'Natto', 1, 0);    // no votes — droppable
}
const POLL_SNAP = (db) => ({
  polls: snap(db, 'SELECT id, question_en, status, sort_order, total_votes FROM retail_polls ORDER BY id'),
  opts: snap(db, 'SELECT id, poll_id, label_en, sort_order, votes FROM retail_poll_options ORDER BY id'),
});

const seedConfig = (db) => db.exec(
  `INSERT INTO storefront_config (key, value_json, updated_by) VALUES ('theme.accent','"kale"',1)`);
const CONFIG_SNAP = (db) => ({
  cfg: snap(db, 'SELECT key, value_json, updated_by FROM storefront_config ORDER BY key'),
});

// ══════════════════════════════════════════════════════════════════════════

(async function main() {
  console.log(`\ntransaction conversion — batch 2   [driver: ${driver}]\n`);

  // ── 1 ────────────────────────────────────────────────────────────────────
  console.log('1. DELETE /media/folders/:id');

  await it('deleting a folder unsorts its media and removes the folder', async () => {
    const r = await bothForms({
      seed: seedMedia,
      runOld: (db, res) => { oldRun(db, bodyFolderDelete, 1); res.json({ success: true }); },
      runNew: async (db, res) => { await newRun(db, bodyFolderDelete, 1); res.json({ success: true }); },
      snapshot: MEDIA_SNAP,
    });
    assertSame(r, 'folder delete');
    assert.deepStrictEqual(r.neu.res.body, { success: true });
    assert.deepStrictEqual(
      r.neu.snap.media.map(m => m.folder_id),
      SABOTAGE ? [1, 1, 2] : [null, null, 2]);
    assert.deepStrictEqual(r.neu.snap.folders.map(f => f.id), [2]);
  });

  await it('a failure between the two statements leaves the folder AND its media alone', async () => {
    const boom = () => { throw new Boom(); };
    const r = await bothForms({
      seed: seedMedia,
      runOld: (db) => oldRun(db, bodyFolderDelete, 1, boom),
      runNew: (db) => newRun(db, bodyFolderDelete, 1, boom),
      snapshot: MEDIA_SNAP,
    });
    assertSame(r, 'folder delete rollback');
    assert.strictEqual(r.neu.threw.code, 'TEST_BOOM');
    assert.strictEqual(r.neu.threw.detail, 'carried', 'error properties must survive');
    // The first UPDATE ran; the rollback must discard it.
    assert.deepStrictEqual(r.neu.snap.media.map(m => m.folder_id), [1, 1, 2]);
    assert.deepStrictEqual(r.neu.snap.folders.map(f => f.id), [1, 2]);
  });

  // ── 2 ────────────────────────────────────────────────────────────────────
  console.log('\n2. POST /media/bulk-move');

  await it('every id moves, and `moved` counts the rows it changed', async () => {
    const mk = (run) => async (db, res) => {
      const counter = { moved: 0 };
      await run(db, bodyBulkMove, [10, 11, 999], 2, counter);
      res.json({ success: true, data: { moved: counter.moved } });
      return counter.moved;
    };
    const r = await bothForms({
      seed: seedMedia,
      runOld: mk((db, b, ...a) => oldRun(db, b, ...a)),
      runNew: mk((db, b, ...a) => newRun(db, b, ...a)),
      snapshot: MEDIA_SNAP,
    });
    assertSame(r, 'bulk-move');
    // id 999 does not exist — 2 changed, not 3. That count is the response.
    assert.deepStrictEqual(r.neu.res.body, { success: true, data: { moved: 2 } });
    assert.deepStrictEqual(r.neu.snap.media.map(m => m.folder_id), [2, 2, 2]);
  });

  await it('a failure partway rolls back every earlier move in the batch', async () => {
    const hook = (id) => { if (id === 11) throw new Boom(); };
    const mk = (run) => (db) => {
      const counter = { moved: 0 };
      return run(db, bodyBulkMove, [10, 11], 2, counter, hook);
    };
    const r = await bothForms({
      seed: seedMedia,
      runOld: mk((db, b, ...a) => oldRun(db, b, ...a)),
      runNew: mk((db, b, ...a) => newRun(db, b, ...a)),
      snapshot: MEDIA_SNAP,
    });
    assertSame(r, 'bulk-move rollback');
    assert.deepStrictEqual(r.neu.snap.media.map(m => m.folder_id), [1, 1, 2],
      'id 10 was already moved when id 11 threw — the rollback must undo it');
  });

  // ── 3 ────────────────────────────────────────────────────────────────────
  console.log('\n3. POST /media/bulk-delete');

  await it('rows go, and `deleted` counts them', async () => {
    const mk = (run) => async (db, res) => {
      const counter = { deleted: 0 };
      await run(db, bodyBulkDelete, [10, 12, 999], counter);
      res.json({ success: true, data: { deleted: counter.deleted } });
    };
    const r = await bothForms({
      seed: seedMedia,
      runOld: mk((db, b, ...a) => oldRun(db, b, ...a)),
      runNew: mk((db, b, ...a) => newRun(db, b, ...a)),
      snapshot: MEDIA_SNAP,
    });
    assertSame(r, 'bulk-delete');
    assert.deepStrictEqual(r.neu.res.body, { success: true, data: { deleted: 2 } });
    assert.deepStrictEqual(r.neu.snap.media.map(m => m.id), [11]);
  });

  await it('a failure partway restores every row in the batch', async () => {
    const hook = (id) => { if (id === 12) throw new Boom(); };
    const mk = (run) => (db) => run(db, bodyBulkDelete, [10, 12], { deleted: 0 }, hook);
    const r = await bothForms({
      seed: seedMedia,
      runOld: mk((db, b, ...a) => oldRun(db, b, ...a)),
      runNew: mk((db, b, ...a) => newRun(db, b, ...a)),
      snapshot: MEDIA_SNAP,
    });
    assertSame(r, 'bulk-delete rollback');
    assert.deepStrictEqual(r.neu.snap.media.map(m => m.id), [10, 11, 12]);
  });

  // ── 4 ────────────────────────────────────────────────────────────────────
  console.log('\n4. POST /media/bulk-tag');

  await it('tags are added and removed per row, unknown ids skipped', async () => {
    const mk = (run) => async (db, res) => {
      await run(db, bodyBulkTag, [10, 11, 999], ['new'], ['old']);
      res.json({ success: true });
    };
    const r = await bothForms({
      seed: seedMedia,
      runOld: mk((db, b, ...a) => oldRun(db, b, ...a)),
      runNew: mk((db, b, ...a) => newRun(db, b, ...a)),
      snapshot: MEDIA_SNAP,
    });
    assertSame(r, 'bulk-tag');
    assert.deepStrictEqual(r.neu.snap.media.map(m => m.tags),
      ['["hero","new"]', '["hero","new"]', '[]']);
  });

  await it('the READ inside the body sees the transaction\'s own uncommitted write', async () => {
    // Tag id 10 twice in one transaction. The second pass can only produce
    // ["hero","new","later"] if its SELECT saw the first pass's UPDATE.
    const body = (h) => {
      bodyBulkTag(h, [10], ['new'], []);
      bodyBulkTag(h, [10], ['later'], []);
    };
    const r = await bothForms({
      seed: seedMedia,
      runOld: (db) => oldRun(db, body),
      runNew: (db) => newRun(db, body),
      snapshot: MEDIA_SNAP,
    });
    assertSame(r, 'bulk-tag read-your-writes');
    assert.strictEqual(r.neu.snap.media[0].tags, '["hero","new","later"]');
  });

  // ── 5 ────────────────────────────────────────────────────────────────────
  console.log('\n5. POST /categories/reorder');

  // The whole handler, both forms — this one is about WHERE the await sits.
  const reorderOld = (db, res, log, ids, hook) => {
    try {
      oldRun(db, bodyCatReorder, ids.map(n => parseInt(n, 10)).filter(Number.isFinite), hook);
      log('update', 'category_order', { kind: 'product', count: ids.length });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: 'reorder_failed' });
    }
  };
  const reorderNew = async (db, res, log, ids, hook) => {
    try {
      const ordered = ids.map(n => parseInt(n, 10)).filter(Number.isFinite);
      await newRun(db, bodyCatReorder, ordered, hook);
      log('update', 'category_order', { kind: 'product', count: ids.length });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: 'reorder_failed' });
    }
  };

  await it('ids are renumbered 1..n, and only the product kind is touched', async () => {
    const r = await bothForms({
      seed: seedCatalogue,
      runOld: (db, res, log) => reorderOld(db, res, log, [3, 1, 2]),
      runNew: (db, res, log) => reorderNew(db, res, log, [3, 1, 2]),
      snapshot: CATALOGUE_SNAP,
    });
    assertSame(r, 'categories reorder');
    assert.deepStrictEqual(r.neu.snap.cats.map(c => [c.id, c.sort_order]),
      [[1, 2], [2, 3], [3, 1], [4, 9]]);
    assert.strictEqual(r.neu.log.length, 1, 'logActivity fires exactly once on success');
  });

  await it('a mid-transaction failure answers 500 reorder_failed and writes nothing', async () => {
    const hook = (i) => { if (i === 1) throw new Boom(); };
    const r = await bothForms({
      seed: seedCatalogue,
      runOld: (db, res, log) => reorderOld(db, res, log, [3, 1, 2], hook),
      runNew: (db, res, log) => reorderNew(db, res, log, [3, 1, 2], hook),
      snapshot: CATALOGUE_SNAP,
    });
    assertSame(r, 'categories reorder failure');
    assert.strictEqual(r.neu.res.status, 500, 'the await must be INSIDE the try');
    assert.deepStrictEqual(r.neu.res.body, { success: false, error: 'reorder_failed' });
    assert.strictEqual(r.neu.log.length, 0, 'logActivity must not fire on failure');
    assert.deepStrictEqual(r.neu.snap.cats.map(c => c.sort_order), [3, 1, 2, 9]);
    assert.strictEqual(r.neu.threw, null, 'the handler must answer, not reject');
  });

  // ── 6 ────────────────────────────────────────────────────────────────────
  console.log('\n6. POST /products/reorder');

  const prodReorderNew = async (db, res, log, ids, hook) => {
    try {
      const placeholders = ids.map(() => '?').join(',');
      const rows = db.prepare(`SELECT id, sort_order FROM store_products WHERE id IN (${placeholders})`).all(...ids);
      if (rows.length !== ids.length) return res.status(400).json({ success: false, error: 'unknown_ids' });
      let slots = rows.map(r => Number(r.sort_order) || 0).sort((a, b) => a - b);
      if (slots[0] === slots[slots.length - 1]) slots = ids.map((_, i) => i + 1);
      await newRun(db, bodyProdReorder, ids, slots, hook);
      log('update', 'product_order', { count: ids.length });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: 'reorder_failed' });
    }
  };
  const prodReorderOld = (db, res, log, ids, hook) => {
    try {
      const placeholders = ids.map(() => '?').join(',');
      const rows = db.prepare(`SELECT id, sort_order FROM store_products WHERE id IN (${placeholders})`).all(...ids);
      if (rows.length !== ids.length) return res.status(400).json({ success: false, error: 'unknown_ids' });
      let slots = rows.map(r => Number(r.sort_order) || 0).sort((a, b) => a - b);
      if (slots[0] === slots[slots.length - 1]) slots = ids.map((_, i) => i + 1);
      oldRun(db, bodyProdReorder, ids, slots, hook);
      log('update', 'product_order', { count: ids.length });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: 'reorder_failed' });
    }
  };

  await it('the set\'s own slots are redistributed, not a fresh 1..n ramp', async () => {
    const r = await bothForms({
      seed: seedCatalogue,
      runOld: (db, res, log) => prodReorderOld(db, res, log, [102, 100, 101]),
      runNew: (db, res, log) => prodReorderNew(db, res, log, [102, 100, 101]),
      snapshot: CATALOGUE_SNAP,
    });
    assertSame(r, 'products reorder');
    // slots present in the set are 10,20,30 → handed out in the new sequence.
    assert.deepStrictEqual(r.neu.snap.prods.map(p => [p.id, p.sort_order]),
      [[100, 20], [101, 30], [102, 10]]);
  });

  await it('an unknown id still short-circuits to 400 before any write', async () => {
    const r = await bothForms({
      seed: seedCatalogue,
      runOld: (db, res, log) => prodReorderOld(db, res, log, [100, 999]),
      runNew: (db, res, log) => prodReorderNew(db, res, log, [100, 999]),
      snapshot: CATALOGUE_SNAP,
    });
    assertSame(r, 'products reorder unknown id');
    assert.strictEqual(r.neu.res.status, 400);
    assert.deepStrictEqual(r.neu.res.body, { success: false, error: 'unknown_ids' });
    assert.deepStrictEqual(r.neu.snap.prods.map(p => p.sort_order), [30, 10, 20]);
  });

  await it('a mid-transaction failure answers 500 and leaves every slot as it was', async () => {
    const hook = (i) => { if (i === 2) throw new Boom(); };
    const r = await bothForms({
      seed: seedCatalogue,
      runOld: (db, res, log) => prodReorderOld(db, res, log, [102, 100, 101], hook),
      runNew: (db, res, log) => prodReorderNew(db, res, log, [102, 100, 101], hook),
      snapshot: CATALOGUE_SNAP,
    });
    assertSame(r, 'products reorder failure');
    assert.strictEqual(r.neu.res.status, 500);
    assert.deepStrictEqual(r.neu.snap.prods.map(p => p.sort_order), [30, 10, 20]);
  });

  // ── 7 ────────────────────────────────────────────────────────────────────
  console.log('\n7. PATCH /categories/:id');

  const renameOld = (db, res, log, id, name, oldName, hook) => {
    try {
      oldRun(db, bodyCatRename, id, name, oldName, hook);
      log('update', 'category', { from: oldName, to: name });
      res.json({ success: true, data: { id, name } });
    } catch (e) {
      if (/UNIQUE/.test(e.message)) return res.status(400).json({ success: false, error: 'duplicate_name' });
      res.status(500).json({ success: false, error: 'update_failed' });
    }
  };
  const renameNew = async (db, res, log, id, name, oldName, hook) => {
    try {
      await newRun(db, bodyCatRename, id, name, oldName, hook);
      log('update', 'category', { from: oldName, to: name });
      res.json({ success: true, data: { id, name } });
    } catch (e) {
      if (/UNIQUE/.test(e.message)) return res.status(400).json({ success: false, error: 'duplicate_name' });
      res.status(500).json({ success: false, error: 'update_failed' });
    }
  };

  await it('a rename propagates to the products that referenced the old name', async () => {
    const r = await bothForms({
      seed: seedCatalogue,
      runOld: (db, res, log) => renameOld(db, res, log, 1, 'Beancurd', 'Tofu'),
      runNew: (db, res, log) => renameNew(db, res, log, 1, 'Beancurd', 'Tofu'),
      snapshot: CATALOGUE_SNAP,
    });
    assertSame(r, 'category rename');
    assert.deepStrictEqual(r.neu.res.body, { success: true, data: { id: 1, name: 'Beancurd' } });
    assert.deepStrictEqual(r.neu.snap.prods.map(p => p.category), ['Beancurd', 'Beancurd', 'Tempeh']);
    // The recipe-kind row named 'Tofu' is a different category and is untouched.
    assert.strictEqual(r.neu.snap.cats.find(c => c.id === 4).name, 'Tofu');
  });

  await it('a duplicate name is still a 400 duplicate_name, not a 500', async () => {
    const r = await bothForms({
      seed: seedCatalogue,
      runOld: (db, res, log) => renameOld(db, res, log, 1, 'Tempeh', 'Tofu'),
      runNew: (db, res, log) => renameNew(db, res, log, 1, 'Tempeh', 'Tofu'),
      snapshot: CATALOGUE_SNAP,
    });
    assertSame(r, 'category rename duplicate');
    assert.strictEqual(r.neu.res.status, SABOTAGE ? 500 : 400,
      'the await must be inside the try, or UNIQUE never reaches this catch');
    assert.deepStrictEqual(r.neu.res.body, { success: false, error: 'duplicate_name' });
    assert.strictEqual(r.neu.threw, null);
    assert.deepStrictEqual(r.neu.snap.cats.map(c => c.name), ['Tofu', 'Tempeh', 'Seitan', 'Tofu']);
  });

  await it('a failure after the rename discards the rename too', async () => {
    const boom = () => { throw new Boom(); };
    const r = await bothForms({
      seed: seedCatalogue,
      runOld: (db, res, log) => renameOld(db, res, log, 1, 'Beancurd', 'Tofu', boom),
      runNew: (db, res, log) => renameNew(db, res, log, 1, 'Beancurd', 'Tofu', boom),
      snapshot: CATALOGUE_SNAP,
    });
    assertSame(r, 'category rename rollback');
    assert.strictEqual(r.neu.res.status, 500);
    assert.strictEqual(r.neu.snap.cats.find(c => c.id === 1).name, 'Tofu');
    assert.deepStrictEqual(r.neu.snap.prods.map(p => p.category), ['Tofu', 'Tofu', 'Tempeh']);
  });

  // ── 8 ────────────────────────────────────────────────────────────────────
  console.log('\n8. POST /polls');

  await it('the new poll id comes back OUT of the transaction and drives the response', async () => {
    const opts = [{ label_en: 'Miso', sort_order: 0 }, { label_en: 'Natto', sort_order: 1 }];
    const body = { question_en: 'Which next?', status: 'draft' };
    const mk = (run) => async (db, res, log) => {
      const pollId = await run(db, bodyPollCreate, body, opts);
      log('create', 'retail_poll', pollId);
      res.json({ success: true, data: { id: pollId } });
      return pollId;
    };
    const r = await bothForms({
      seed: () => {},
      runOld: mk((db, b, ...a) => oldRun(db, b, ...a)),
      runNew: mk((db, b, ...a) => newRun(db, b, ...a)),
      snapshot: POLL_SNAP,
    });
    assertSame(r, 'poll create');
    assert.strictEqual(Number(r.neu.value), 1, 'the body returns the new id');
    assert.deepStrictEqual(r.neu.res.body, { success: true, data: { id: r.neu.value } });
    assert.strictEqual(r.neu.snap.opts.length, 2);
    assert.deepStrictEqual(r.neu.snap.opts.map(o => o.label_en), ['Miso', 'Natto']);
  });

  await it('a failure before the options leaves NO poll behind', async () => {
    const boom = () => { throw new Boom(); };
    const opts = [{ label_en: 'Miso', sort_order: 0 }];
    const body = { question_en: 'Which next?', status: 'draft' };
    const r = await bothForms({
      seed: () => {},
      runOld: (db) => oldRun(db, bodyPollCreate, body, opts, boom),
      runNew: (db) => newRun(db, bodyPollCreate, body, opts, boom),
      snapshot: POLL_SNAP,
    });
    assertSame(r, 'poll create rollback');
    assert.deepStrictEqual(r.neu.snap.polls, [], 'a poll with no options must not survive');
    assert.deepStrictEqual(r.neu.snap.opts, []);
  });

  // ── 9 ────────────────────────────────────────────────────────────────────
  console.log('\n9. PUT /polls/:id');

  const pollUpdOld = (db, res, log, updates, opts, hook) => {
    try { oldRun(db, bodyPollUpdate, 7, updates, opts, hook); }
    catch (e) { return res.status(500).json({ success: false, error: 'update_failed' }); }
    log('update', 'retail_poll', Object.keys(updates));
    res.json({ success: true, data: { id: 7 } });
  };
  const pollUpdNew = async (db, res, log, updates, opts, hook) => {
    try { await newRun(db, bodyPollUpdate, 7, updates, opts, hook); }
    catch (e) { return res.status(500).json({ success: false, error: 'update_failed' }); }
    log('update', 'retail_poll', Object.keys(updates));
    res.json({ success: true, data: { id: 7 } });
  };

  await it('in-place edits keep vote counts, add new options, drop only unvoted ones', async () => {
    const updates = { status: 'closed', sort_order: 5 };
    const opts = [{ id: 70, label_en: 'Miso paste' }, { label_en: 'Yuba' }];
    const r = await bothForms({
      seed: seedPolls,
      runOld: (db, res, log) => pollUpdOld(db, res, log, updates, opts),
      runNew: (db, res, log) => pollUpdNew(db, res, log, updates, opts),
      snapshot: POLL_SNAP,
    });
    assertSame(r, 'poll update');
    assert.deepStrictEqual(r.neu.res.body, { success: true, data: { id: 7 } });
    assert.strictEqual(r.neu.snap.polls[0].status, 'closed');
    assert.deepStrictEqual(r.neu.snap.opts.map(o => [o.label_en, o.votes]),
      [['Miso paste', 4], ['Yuba', 0]],
      'id 70 renamed and kept its 4 votes; id 71 had none and was dropped');
  });

  await it('an option WITH votes survives being dropped from the form', async () => {
    const opts = [{ label_en: 'Only this' }];      // 70 (4 votes) and 71 (0) both absent
    const r = await bothForms({
      seed: seedPolls,
      runOld: (db, res, log) => pollUpdOld(db, res, log, {}, opts),
      runNew: (db, res, log) => pollUpdNew(db, res, log, {}, opts),
      snapshot: POLL_SNAP,
    });
    assertSame(r, 'poll update vote guard');
    assert.deepStrictEqual(r.neu.snap.opts.map(o => o.label_en).sort(), ['Miso', 'Only this']);
  });

  await it('a failure answers 500 update_failed and rolls the whole edit back', async () => {
    const boom = () => { throw new Boom(); };
    const updates = { status: 'closed' };
    const r = await bothForms({
      seed: seedPolls,
      runOld: (db, res, log) => pollUpdOld(db, res, log, updates, [{ label_en: 'X' }], boom),
      runNew: (db, res, log) => pollUpdNew(db, res, log, updates, [{ label_en: 'X' }], boom),
      snapshot: POLL_SNAP,
    });
    assertSame(r, 'poll update failure');
    assert.strictEqual(r.neu.res.status, 500, 'the await must be INSIDE the try');
    assert.deepStrictEqual(r.neu.res.body, { success: false, error: 'update_failed' });
    assert.strictEqual(r.neu.log.length, 0);
    assert.strictEqual(r.neu.snap.polls[0].status, 'open', 'the status UPDATE ran before the throw');
    assert.deepStrictEqual(r.neu.snap.opts.map(o => o.id), [70, 71]);
  });

  // ── 10 ───────────────────────────────────────────────────────────────────
  console.log('\n10. PUT /config');

  const cfgOld = (db, res, log, entries, hook) => {
    try { oldRun(db, bodyConfigWrite, entries, 9, hook); }
    catch (e) { return res.status(500).json({ success: false, error: 'update_failed' }); }
    log('update', 'storefront_config', entries.map(e => e[0]));
    res.json({ success: true });
  };
  const cfgNew = async (db, res, log, entries, hook) => {
    try { await newRun(db, bodyConfigWrite, entries, 9, hook); }
    catch (e) { return res.status(500).json({ success: false, error: 'update_failed' }); }
    log('update', 'storefront_config', entries.map(e => e[0]));
    res.json({ success: true });
  };

  await it('keys are inserted and existing ones upserted in one unit', async () => {
    const entries = [['theme.accent', 'moss'], ['fees.freeShippingThreshold', 449]];
    const r = await bothForms({
      seed: seedConfig,
      runOld: (db, res, log) => cfgOld(db, res, log, entries),
      runNew: (db, res, log) => cfgNew(db, res, log, entries),
      snapshot: CONFIG_SNAP,
    });
    assertSame(r, 'config write');
    assert.deepStrictEqual(r.neu.res.body, { success: true });
    assert.deepStrictEqual(r.neu.snap.cfg.map(c => [c.key, c.value_json, c.updated_by]),
      [['fees.freeShippingThreshold', '449', 9], ['theme.accent', '"moss"', 9]]);
  });

  await it('a failure on the second key discards the first and answers 500', async () => {
    const hook = (k) => { if (k === 'fees.freeShippingThreshold') throw new Boom(); };
    const entries = [['theme.accent', 'moss'], ['fees.freeShippingThreshold', 449]];
    const r = await bothForms({
      seed: seedConfig,
      runOld: (db, res, log) => cfgOld(db, res, log, entries, hook),
      runNew: (db, res, log) => cfgNew(db, res, log, entries, hook),
      snapshot: CONFIG_SNAP,
    });
    assertSame(r, 'config write failure');
    assert.strictEqual(r.neu.res.status, 500);
    assert.deepStrictEqual(r.neu.snap.cfg.map(c => [c.key, c.value_json]),
      [['theme.accent', '"kale"']], 'the accent upsert must be rolled back to its seeded value');
    assert.strictEqual(r.neu.log.length, 0);
  });

  // ── 11 ───────────────────────────────────────────────────────────────────
  console.log('\n11. concurrency on the shared handle');

  await it('two converted routes started together do not interleave', async () => {
    // The hazard §24 records: SQLite transactions belong to a CONNECTION, and
    // the app shares one handle. Started without awaiting the first, these two
    // would otherwise have overlapping BEGIN/COMMIT windows.
    const db = openDb(); seedMedia(db); seedCatalogue(db);
    const order = [];
    const traced = (label, body) => (h, ...a) => { order.push(`${label}:in`); const r = body(h, ...a); order.push(`${label}:out`); return r; };
    const a = withTransaction(db, (tx) => traced('tag', bodyBulkTag)(tx, [10, 11], ['x'], []));
    const b = withTransaction(db, (tx) => traced('sort', bodyCatReorder)(tx, [3, 2, 1]));
    await Promise.all([a, b]);
    assert.deepStrictEqual(order, ['tag:in', 'tag:out', 'sort:in', 'sort:out'],
      'the second must not begin before the first has finished');
    assert.strictEqual(transactionDepth(db), 0, 'depth must return to 0');
    assert.deepStrictEqual(snap(db, 'SELECT sort_order FROM categories ORDER BY id').map(c => c.sort_order),
      [3, 2, 1, 9]);
  });

  await it('a failing transaction does not take a concurrent one\'s writes with it', async () => {
    const db = openDb(); seedMedia(db); seedCatalogue(db);
    const failing = withTransaction(db, (tx) => {
      bodyBulkMove(tx, [10], 2, { moved: 0 });
      throw new Boom();
    }).catch(e => e);
    const ok = withTransaction(db, (tx) => bodyCatReorder(tx, [3, 2, 1]));
    const [e] = await Promise.all([failing, ok]);
    assert.strictEqual(e.code, 'TEST_BOOM');
    assert.strictEqual(snap(db, 'SELECT folder_id FROM retail_media WHERE id = 10')[0].folder_id, 1,
      'the failing transaction rolled back');
    assert.deepStrictEqual(snap(db, 'SELECT sort_order FROM categories ORDER BY id').map(c => c.sort_order),
      [3, 2, 1, 9], 'the concurrent transaction still committed');
  });

  await it('a legacy db.transaction() cannot land inside a converted one', async () => {
    // The overlap the helper's queue does NOT cover: an unconverted, synchronous
    // db.transaction() elsewhere in retail.js. It is safe for THIS batch only
    // because none of the ten bodies awaits anything real — the whole
    // BEGIN…COMMIT chain resolves in microtasks, and a macrotask (another
    // request, a timer) cannot run until after the COMMIT. Demonstrated, not
    // assumed, because it is the property the next batch has to re-check.
    const db = openDb(); seedMedia(db); seedCatalogue(db);
    const order = [];
    setImmediate(() => {
      order.push('legacy');
      makeOldTx(db, () => bodyCatReorder(db, [3, 2, 1]))();
    });
    await withTransaction(db, (tx) => { order.push('converted'); bodyBulkTag(tx, [10], ['x'], []); });
    order.push('after-commit');
    await new Promise(r => setImmediate(() => setImmediate(r)));
    assert.deepStrictEqual(order, ['converted', 'after-commit', 'legacy'],
      'the legacy transaction must run strictly after the converted one committed');
  });

  // ── 12 ───────────────────────────────────────────────────────────────────
  console.log('\n12. the converted source itself');

  // Pull each converted route's handler text out of routes/retail.js by walking
  // braces from its registration, so these assertions are about the real file
  // rather than the copies above.
  function handlerSource(method, routePath) {
    const re = new RegExp(`router\\.${method}\\('${routePath.replace(/[/:]/g, m => '\\' + m)}'`);
    const m = re.exec(RETAIL_SRC);
    if (!m) throw new Error(`route ${method.toUpperCase()} ${routePath} not found`);
    let i = RETAIL_SRC.indexOf('{', m.index), depth = 0;
    for (; i < RETAIL_SRC.length; i++) {
      const c = RETAIL_SRC[i];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
    }
    return RETAIL_SRC.slice(m.index, i + 1);
  }

  const CONVERTED = [
    ['delete', '/api/retail-admin/media/folders/:id'],
    ['post', '/api/retail-admin/media/bulk-move'],
    ['post', '/api/retail-admin/media/bulk-delete'],
    ['post', '/api/retail-admin/media/bulk-tag'],
    ['post', '/api/retail-admin/categories/reorder'],
    ['post', '/api/retail-admin/products/reorder'],
    ['patch', '/api/retail-admin/categories/:id'],
    ['post', '/api/retail-admin/polls'],
    ['put', '/api/retail-admin/polls/:id'],
    ['put', '/api/retail-admin/config'],
  ];

  await it('all ten handlers are async, and none still calls db.transaction()', async () => {
    for (const [method, p] of CONVERTED) {
      const src = handlerSource(method, p);
      assert.ok(/async\s*\(req,\s*res\)/.test(src), `${method} ${p} is not async`);
      assert.ok(!/\.transaction\(/.test(src), `${method} ${p} still calls .transaction()`);
      assert.ok(/withTransaction\(/.test(src), `${method} ${p} does not use withTransaction`);
    }
  });

  await it('no converted body reaches for tdb() instead of the handle it was given', async () => {
    // The failure this exists to catch: on SQLite tdb() and `tx` are the SAME
    // object, so a body that used tdb() would pass every row comparison in this
    // file and only break at the pg cutover, on a different connection, outside
    // its own transaction. Only the source can show it.
    for (const [method, p] of CONVERTED) {
      const src = handlerSource(method, p);
      // Each withTransaction(...) body, from the arrow to its closing brace.
      let idx = 0;
      while ((idx = src.indexOf('withTransaction(', idx)) !== -1) {
        let i = src.indexOf('{', idx), depth = 0, end = i;
        // A handle-only call like withTransaction(tdb(), applyPollUpdate) has no
        // inline body — the named body is checked as part of the handler anyway.
        if (i === -1) break;
        for (; i < src.length; i++) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        const body = src.slice(src.indexOf('{', idx), end + 1);
        assert.ok(!/tdb\(\)/.test(body), `${method} ${p}: a transaction body still calls tdb()`);
        idx = end + 1;
      }
      // And the named body form: everything between `const applyPollUpdate` and
      // its use is inside the handler text, so a file-wide check covers it.
      if (/const applyPollUpdate/.test(src)) {
        const start = src.indexOf('const applyPollUpdate');
        const stop = src.indexOf('withTransaction(', start);
        assert.ok(!/tdb\(\)/.test(src.slice(start, stop)),
          `${method} ${p}: applyPollUpdate still calls tdb()`);
      }
    }
  });

  await it('no converted body awaits — so no request can begin inside one', async () => {
    // The premise section 11's third test demonstrates. If a future edit puts a
    // real await inside one of these bodies, this fails and the interleaving
    // question has to be answered again for that route.
    for (const [method, p] of CONVERTED) {
      const src = handlerSource(method, p);
      const bodies = [...src.matchAll(/withTransaction\(tdb\(\),\s*\(tx\)\s*=>\s*\{/g)];
      for (const b of bodies) {
        let i = src.indexOf('{', b.index + b[0].length - 1), depth = 0, end = i;
        for (; i < src.length; i++) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        const body = src.slice(b.index + b[0].length - 1, end + 1);
        assert.ok(!/\bawait\b/.test(body), `${method} ${p}: a transaction body now awaits`);
      }
    }
  });

  await it('the money cluster, the checkout and the four excluded routes are untouched', async () => {
    // Each must still be on the OLD form. If one of these ever fails, something
    // in this batch reached further than it was meant to.
    const stillOld = [
      ['post', '/api/retail-admin/brand/apply'],
      ['post', '/api/retail-admin/brand/publish'],
      ['post', '/api/retail-admin/products/:id/duplicate'],
      ['post', '/api/retail-admin/products/:id/restore-version'],
      ['post', '/api/retail-admin/vouchers/:id/grant'],
      ['post', '/api/retail-admin/customers/:id/wallet-adjust'],
      ['post', '/api/retail-admin/customers/:id/points-adjust'],
    ];
    for (const [method, p] of stillOld) {
      const src = handlerSource(method, p);
      assert.ok(/\.transaction\(/.test(src), `${method} ${p} was converted — it must not be`);
    }
    assert.ok(/\.immediate\(/.test(RETAIL_SRC), 'the checkout\'s .immediate() must still be there');
    // Counted, so a stray conversion elsewhere in the file is visible. This
    // number is MEANT to move with each batch, and the failure it produces is
    // the guard working — it is the tripwire for a conversion nobody intended,
    // so it is updated deliberately per batch rather than loosened into a range.
    //
    // IT READS THE AST AUTHORITY, NOT GREP. The first version of this counted
    // /\.transaction\(/ over the raw source and stood at 45 while the figure of
    // record was 44: grep matches a COMMENT that mentions tdb().transaction().
    // A test that disagrees with the number §24 carries is worse than no test,
    // because the next person has to work out which one lied.
    const remaining = countTransactionsAuthoritative();
    if (remaining === null) {
      console.log('        (count check SKIPPED — espree unavailable, so the AST');
      console.log('         authority cannot run here. Expected on the box.)');
    } else {
      assert.strictEqual(remaining, 30,
        `expected 30 unconverted transactions left in routes/retail.js, found ${remaining}`);
    }
  });

  // ── 13 ───────────────────────────────────────────────────────────────────
  console.log('\n13. the async guard, on real express');

  // routes/retail.js cannot be required from a test — it opens the database at
  // load, registers routes and starts intervals. So coverage is established in
  // two halves that meet: section 12 proved each of the ten is an `async (req,
  // res)` handler registered through `router.<method>(...)`, and this section
  // proves — against the real express and the real guard — that a registration
  // of exactly that shape has its FINAL handler wrapped, however many
  // middleware precede it, and that a rejection from it reaches next(err).
  const express = require('express');
  require('../lib/express-async-guard');
  const { GUARDED } = require('../lib/express-async-guard');

  await it('the final handler is wrapped in every registration shape the ten use', async () => {
    const router = express.Router();
    const mw = (req, res, next) => next();
    // The three shapes present among the ten, verbatim from routes/retail.js.
    router.delete('/a/:id', mw, async (req, res) => { res.json({}); });          // no body parser
    router.post('/b', mw, express.json(), async (req, res) => { res.json({}); }); // parser
    router.put('/c/:id', mw, express.json(), async (req, res) => { res.json({}); });
    assert.strictEqual(router.stack.length, 3);
    for (const layer of router.stack) {
      const handlers = layer.route.stack.map(s => s.handle);
      const final = handlers[handlers.length - 1];
      assert.strictEqual(final[GUARDED], true,
        `the final handler of ${layer.route.path} is not guarded`);
      assert.ok(final.__unguarded.constructor.name === 'AsyncFunction',
        'the wrapped function should be the async handler itself');
    }
  });

  await it('a rejection from an async handler reaches express\'s error path', async () => {
    // The failure the guard exists to prevent: without it the request gets NO
    // response at all. Driven through the real Layer dispatch.
    const router = express.Router();
    router.post('/boom', express.json(), async (req, res) => { throw new Boom(); });
    const layer = router.stack[0];
    const final = layer.route.stack[layer.route.stack.length - 1].handle;
    const seen = await new Promise((resolve) => {
      const out = final({}, mkRes().res, (err) => resolve(err));
      // The guard must hand the promise back too, unchanged.
      assert.ok(out && typeof out.then === 'function', 'the guard must return the promise');
      out.catch(() => {});
    });
    assert.strictEqual(seen.code, 'TEST_BOOM', 'next(err) must receive the ORIGINAL error');
    assert.strictEqual(seen.detail, 'carried', 'and its properties');
  });

  // ── result ───────────────────────────────────────────────────────────────
  const note = REAL_OLD ? 'old-form: real db.transaction()' : 'old-form: reference';
  console.log(`\n${pass} passed, ${fail} failed   [driver: ${driver}, ${note}]\n`);
  if (SABOTAGE) console.log('(TX_CONV2_SABOTAGE=1 — failures above are the point)\n');
  process.exit(fail ? 1 : 0);
})();
