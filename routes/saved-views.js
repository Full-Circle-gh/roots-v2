// Saved views — a named set of filters, pinned to the screen it belongs to
// (audit E-08).
//
// ── WHAT WAS WRONG ────────────────────────────────────────────────────────
// "Unpaid orders from the Web channel at the Tianhe shop" had to be rebuilt
// from three controls every morning, and could not be handed to a colleague.
// Nothing in the admin remembered a view: filter state lived in page variables
// and went with the reload.
//
// ── THE SHAPE ─────────────────────────────────────────────────────────────
// A view is a NAME, a SCREEN, and the screen's own filter keys. Nothing else.
// It holds no rows and grants no access: applying somebody else's view runs the
// same list query the person applying it could have built by hand, through the
// same gate, so a shared view can never show a colleague something their own
// capabilities would not.
//
// PRIVATE BY DEFAULT, SHARED ON PURPOSE. `shared = 1` is a deliberate act with
// its own control, because the two are different things: a working view is
// scratch, and a shared one is a claim about how the team works.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
// No default view, and no "restore my last filters on load". Both were
// tempting; both mean a screen that opens showing less than everything for a
// reason the operator cannot see, and "why is this order missing" is a far
// worse morning than rebuilding a filter. A view applies when somebody picks it.

'use strict';

const express = require('express');
const router = express.Router();
const { tdb } = require('../lib/tenant-db');
const { requireRetailAdmin } = require('./retail');

// The screens that may own a view. A closed list, because the value is stored
// and comes back into a URL: an open one makes this table a place to park
// arbitrary strings, and a typo becomes a view nobody can ever see again.
const SCREENS = new Set(['orders']);

// Bounds. A view is a handful of short filter values; anything past this is not
// a view somebody built out of the controls on a screen.
const MAX_NAME = 60;
const MAX_KEYS = 12;
const MAX_VALUE = 200;
const MAX_PER_PERSON = 50;

/**
 * The stored form of a filter set: a flat object of short strings.
 *
 * Everything else is DROPPED rather than rejected — a screen that grows a
 * control sends a key this build has never seen, and refusing the save would
 * make the newer screen unusable against the older server. Dropping means the
 * view narrows by one fewer thing, which is visible and harmless.
 */
function cleanQuery(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const k of Object.keys(raw)) {
    if (Object.keys(out).length >= MAX_KEYS) break;
    if (!/^[a-z][a-z0-9_]{0,30}$/i.test(k)) continue;
    const v = raw[k];
    if (v == null || v === '') continue;
    if (typeof v === 'object') continue;
    const s = String(v);
    if (s.length > MAX_VALUE) continue;
    out[k] = s;
  }
  return out;
}

const who = (req) => ({
  id: (req.user && req.user.id) || null,
  name: (req.user && (req.user.display_name || req.user.username)) || null,
});

function rowOut(r, meId) {
  let query = {};
  try { query = JSON.parse(r.query_json) || {}; } catch (e) { query = {}; }
  return {
    id: r.id, screen: r.screen, name: r.name, query,
    shared: !!r.shared, owner_id: r.owner_id, owner_name: r.owner_name,
    mine: r.owner_id != null && r.owner_id === meId,
  };
}

// Everything this person may use on this screen: their own, plus the account's
// shared ones. Somebody else's PRIVATE view is not listed and not reachable.
router.get('/api/retail-admin/views', requireRetailAdmin, (req, res) => {
  const screen = String(req.query.screen || '');
  if (!SCREENS.has(screen)) return res.status(400).json({ success: false, error: 'unknown_screen' });
  const me = who(req);
  try {
    const rows = tdb().prepare(
      `SELECT * FROM saved_views
        WHERE screen = ? AND (shared = 1 OR owner_id IS ?)
        ORDER BY shared, sort_order, name COLLATE NOCASE`
    ).all(screen, me.id);
    res.json({ success: true, data: rows.map((r) => rowOut(r, me.id)) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/api/retail-admin/views', requireRetailAdmin, express.json(), (req, res) => {
  const b = req.body || {};
  const screen = String(b.screen || '');
  if (!SCREENS.has(screen)) return res.status(400).json({ success: false, error: 'unknown_screen' });
  const name = String(b.name == null ? '' : b.name).trim().slice(0, MAX_NAME);
  if (!name) return res.status(400).json({ success: false, error: 'name_required' });
  const query = cleanQuery(b.query);
  // A view of nothing is the unfiltered list, which already has a name: the
  // screen. Saving it would be a control that does nothing, on a menu.
  if (!Object.keys(query).length) return res.status(400).json({ success: false, error: 'no_filters' });
  const me = who(req);
  const db = tdb();
  try {
    const mine = db.prepare('SELECT COUNT(*) AS n FROM saved_views WHERE screen = ? AND owner_id IS ?')
      .get(screen, me.id).n;
    if (mine >= MAX_PER_PERSON) return res.status(400).json({ success: false, error: 'too_many_views' });
    // Same name, same screen, same person REPLACES rather than making a second
    // one — "save" on a view you already have is how somebody updates it, and
    // two identical names on one menu is the worse outcome either way.
    const existing = db.prepare('SELECT id FROM saved_views WHERE screen = ? AND owner_id IS ? AND name = ?')
      .get(screen, me.id, name);
    if (existing) {
      db.prepare(`UPDATE saved_views SET query_json = ?, shared = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(JSON.stringify(query), b.shared ? 1 : 0, existing.id);
      return res.json({ success: true, id: existing.id, replaced: true });
    }
    const r = db.prepare(
      `INSERT INTO saved_views (screen, name, query_json, owner_id, owner_name, shared)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(screen, name, JSON.stringify(query), me.id, me.name, b.shared ? 1 : 0);
    res.json({ success: true, id: r.lastInsertRowid, replaced: false });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Rename, re-share, or re-point a view at the filters now on screen.
router.patch('/api/retail-admin/views/:id', requireRetailAdmin, express.json(), (req, res) => {
  const me = who(req);
  const db = tdb();
  const row = db.prepare('SELECT * FROM saved_views WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'not_found' });
  // Only the person who saved it. A shared view is somebody's statement about
  // how they work; editing it out from under them is not a nicety.
  if (row.owner_id == null || row.owner_id !== me.id) {
    return res.status(403).json({ success: false, error: 'not_yours' });
  }
  const b = req.body || {};
  const name = b.name == null ? row.name : String(b.name).trim().slice(0, MAX_NAME);
  if (!name) return res.status(400).json({ success: false, error: 'name_required' });
  const query = b.query === undefined ? null : cleanQuery(b.query);
  if (query && !Object.keys(query).length) return res.status(400).json({ success: false, error: 'no_filters' });
  try {
    db.prepare(`UPDATE saved_views SET name = ?, shared = ?, query_json = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`)
      .run(name, b.shared === undefined ? row.shared : (b.shared ? 1 : 0),
        query ? JSON.stringify(query) : row.query_json, row.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.delete('/api/retail-admin/views/:id', requireRetailAdmin, (req, res) => {
  const me = who(req);
  const db = tdb();
  const row = db.prepare('SELECT * FROM saved_views WHERE id = ?').get(req.params.id);
  if (!row) return res.json({ success: true });          // already gone is the asked-for state
  // Its owner, or the account's owner — who has to be able to clear up after
  // somebody who has left, and is the only other person a shared view is
  // really answerable to.
  const isAccountOwner = req.backendUser && req.backendUser.role === 'owner';
  if (!(row.owner_id === me.id || isAccountOwner)) {
    return res.status(403).json({ success: false, error: 'not_yours' });
  }
  try {
    db.prepare('DELETE FROM saved_views WHERE id = ?').run(row.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
module.exports.cleanQuery = cleanQuery;
module.exports.SCREENS = SCREENS;
