// Edit history — the one place a settings screen keeps its earlier versions.
//
// WHY THIS EXISTS. Decisions §279: settings screens save themselves, with an
// Undo and a History list, the same way on the phone and the desktop. A screen
// with no Save button needs a way back, and the way back has to be built ONCE
// rather than once per screen — products already have their own
// (retail_product_versions, routes/retail.js), and this is that idea made
// generic so the next screen converted to autosave brings a type name and a
// snapshot function, not a table.
//
// WHAT A ROW IS. A snapshot of the thing's editable fields at a moment, keyed by
// (tenant_id, entity_type, entity_key). The caller decides what "editable
// fields" means — a role's snapshot is its names, descriptions, board, cards and
// permissions — and must build it in a FIXED KEY ORDER, because two snapshots
// are compared as JSON strings.
//
// THE TWO CALLS A SAVE MAKES, around its own write:
//   before(...)  — the state about to be overwritten. Written only when the
//                  newest row does not already say it, so the first save of all
//                  lays down the "Original", and a change that reached the row
//                  by some other door (a route that does not record) is caught
//                  before this save covers it. edited_by is NULL: we do not know
//                  who made a state we only found.
//   after(...)   — the state the save produced. A burst of autosaves from the
//                  same person collapses into ONE evolving row (COLLAPSE_MS), so
//                  typing a name is one version, not forty. An Undo or a restore
//                  never collapses and is never collapsed into: it is the step
//                  somebody may want to undo in turn, and folding it into the
//                  edit it reversed would lose the edit.
//
// Pruned to the Original plus the newest KEEP rows per thing.

'use strict';

const { seam } = require('./db-seam');

const COLLAPSE_MS = 10 * 60 * 1000;
const KEEP = 30;

const _ready = new WeakSet();
function ensureSchema(db) {
  if (_ready.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS edit_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id     INTEGER NOT NULL,
      entity_type   TEXT NOT NULL,      -- 'role', and each screen converted after it
      entity_key    TEXT NOT NULL,      -- the thing's own key or id, as text
      snapshot_json TEXT NOT NULL,      -- its editable fields, fixed key order
      is_baseline   INTEGER NOT NULL DEFAULT 0,  -- 1 = the Original, never pruned
      note          TEXT,               -- NULL = an edit; 'undo' | 'restore'
      edited_by     TEXT,               -- who saved it; NULL for a found state
      edited_by_id  INTEGER,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_edit_history_thing
      ON edit_history(tenant_id, entity_type, entity_key, id);
  `);
  _ready.add(db);
}

function wrap(raw) { return seam(raw); }

function latest(db, tid, type, key) {
  return db.prepare(`SELECT id, snapshot_json, is_baseline, note, edited_by_id, updated_at
                       FROM edit_history WHERE tenant_id = ? AND entity_type = ? AND entity_key = ?
                      ORDER BY id DESC LIMIT 1`).get(tid, type, String(key));
}

function prune(db, tid, type, key) {
  const stale = db.prepare(`SELECT id FROM edit_history
                             WHERE tenant_id = ? AND entity_type = ? AND entity_key = ? AND is_baseline = 0
                             ORDER BY id DESC LIMIT -1 OFFSET ?`).all(tid, type, String(key), KEEP);
  if (!stale.length) return;
  db.prepare(`DELETE FROM edit_history WHERE id IN (${stale.map(() => '?').join(',')})`)
    .run(...stale.map(s => s.id));
}

// SQLite's CURRENT_TIMESTAMP is UTC without a zone; read it as UTC.
function stampMs(s) {
  const t = Date.parse(String(s || '').replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? t : 0;
}

function before(rawDb, tid, type, key, snapshot) {
  const db = wrap(rawDb); ensureSchema(rawDb);
  const json = JSON.stringify(snapshot);
  const top = latest(db, tid, type, key);
  if (top && top.snapshot_json === json) return;
  db.prepare(`INSERT INTO edit_history (tenant_id, entity_type, entity_key, snapshot_json, is_baseline)
              VALUES (?, ?, ?, ?, ?)`).run(tid, type, String(key), json, top ? 0 : 1);
}

function after(rawDb, tid, type, key, snapshot, who, opts) {
  const db = wrap(rawDb); ensureSchema(rawDb);
  const json = JSON.stringify(snapshot);
  const note = opts && opts.note ? String(opts.note) : null;
  const byId = who && who.id != null ? Number(who.id) : null;
  const byName = (who && who.name) || null;
  const top = latest(db, tid, type, key);
  if (top && top.snapshot_json === json) return;
  const collapse = top && !note && !top.note && !top.is_baseline && byId != null
    && top.edited_by_id === byId && (Date.now() - stampMs(top.updated_at)) < COLLAPSE_MS;
  if (collapse) {
    db.prepare(`UPDATE edit_history SET snapshot_json = ?, edited_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(json, byName, top.id);
  } else {
    db.prepare(`INSERT INTO edit_history (tenant_id, entity_type, entity_key, snapshot_json, is_baseline, note, edited_by, edited_by_id)
                VALUES (?, ?, ?, ?, 0, ?, ?, ?)`).run(tid, type, String(key), json, note, byName, byId);
  }
  prune(db, tid, type, key);
}

// Newest first. Each row carries its snapshot; the caller says what changed.
function list(rawDb, tid, type, key) {
  const db = wrap(rawDb); ensureSchema(rawDb);
  return db.prepare(`SELECT id, snapshot_json, is_baseline, note, edited_by, updated_at
                       FROM edit_history WHERE tenant_id = ? AND entity_type = ? AND entity_key = ?
                      ORDER BY id DESC`).all(tid, type, String(key))
    .map(r => ({
      id: r.id, isBaseline: !!r.is_baseline, note: r.note || null, by: r.edited_by || null,
      at: r.updated_at, snapshot: JSON.parse(r.snapshot_json),
    }));
}

function get(rawDb, tid, type, key, id) {
  const db = wrap(rawDb); ensureSchema(rawDb);
  const r = db.prepare(`SELECT snapshot_json FROM edit_history
                         WHERE id = ? AND tenant_id = ? AND entity_type = ? AND entity_key = ?`)
    .get(Number(id), tid, type, String(key));
  return r ? JSON.parse(r.snapshot_json) : null;
}

// A deleted thing takes its history with it; a new thing reusing its key must
// not inherit an Original that was never its own.
function forget(rawDb, tid, type, key) {
  const db = wrap(rawDb); ensureSchema(rawDb);
  db.prepare('DELETE FROM edit_history WHERE tenant_id = ? AND entity_type = ? AND entity_key = ?')
    .run(tid, type, String(key));
}

// A route's write, recorded around: `snap()` reads the thing's editable fields
// (called before and after), `write()` is the route's own synchronous write.
// Best-effort on both sides — failing to record never fails the write.
function around(db, tid, type, key, snap, who, note, write) {
  try { before(db, tid, type, key, snap()); } catch (e) { console.error('[history before]', type, e.message); }
  const out = write();
  try { after(db, tid, type, key, snap(), who, { note }); } catch (e) { console.error('[history after]', type, e.message); }
  return out;
}
// The shape a history GET answers with: newest first, each version with what
// changed against the one before it (top-level keys of the snapshot).
function versionsOf(rows) {
  return rows.map((r, i) => {
    const s = r.snapshot || {}, prev = rows[i + 1] ? rows[i + 1].snapshot || {} : null;
    const changed = prev ? Object.keys(s).filter(k => JSON.stringify(s[k]) !== JSON.stringify(prev[k])) : [];
    return { id: r.id, at: r.at, by: r.by, isBaseline: r.isBaseline, note: r.note, changed, snapshot: s };
  });
}
const NOTES = new Set(['undo', 'restore']);
// The history options a self-saving editor sends in its query string:
// ?history=1 to be recorded, &note=undo|restore to file the step as one.
function fromQuery(q) {
  q = q || {};
  return { on: !!q.history, note: NOTES.has(q.note) ? q.note : null };
}

module.exports = { before, after, list, get, forget, around, versionsOf, fromQuery, COLLAPSE_MS, KEEP };
