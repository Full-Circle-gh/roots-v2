// The voice assistant's routes (§495). Three, none of which writes stock,
// menus or status: the plan is read here, the phone executes it through the
// routes that already do each thing, under the operator's own login.
//
//   POST /api/retail-admin/assistant/plan     a sentence → a plan (or a question)
//   POST /api/retail-admin/assistant/outcome  what the operator approved and what ran
//   GET  /api/retail-admin/assistant/log      the last days, for whoever reads it
//
// THE DOOR HAS THREE LOCKS, in this order: the tenant holds the paid module
// (tenants.features_json, §495), the tenant has not switched it off (Settings
// → Features), and the operator's role carries `assistant:use`. The first is
// what makes it a module a new tenant pays for; the other two are the same
// two every feature has.
'use strict';

const express = require('express');
const router = express.Router();

const db = require('../database');
const { tdb } = require('../lib/tenant-db');
const features = require('../lib/features');
const assistant = require('../lib/assistant');
const { requireRetailAdmin } = require('./retail');

const KEEP_DAYS = 90;

function userKey(req) { return req.backendUser ? 'b:' + req.backendUser.id : null; }

function requireAssistant(req, res, next) {
  const tenant = req.tenant || null;
  const ent = features.entitlements(tenant ? tenant.features_json : null);
  if (!ent.assistant) return res.status(403).json({ success: false, error: 'module_not_held', message: 'The voice assistant is not part of this account’s plan.' });
  if (!features.assistantEnabled(tdb())) return res.status(403).json({ success: false, error: 'assistant_off', message: 'The voice assistant is switched off for this account.' });
  if (req.caps instanceof Set && !req.caps.has('assistant:use')) return res.status(403).json({ success: false, error: 'forbidden' });
  next();
}

function namesFor(req) {
  const me = userKey(req);
  const mine = [], others = [];
  let rows = [];
  try { rows = tdb().prepare('SELECT user_key, kind, heard, target_id FROM assistant_names ORDER BY hits ASC').all(); }
  catch (e) { rows = []; }
  for (const r of rows) (r.user_key === me ? mine : others).push({ kind: r.kind, heard: r.heard, target_id: r.target_id });
  // This person's first, then the shop's: the model reads them in order.
  return mine.concat(others);
}

function learn(req, items) {
  const me = userKey(req);
  if (!me || !Array.isArray(items)) return;
  const up = tdb().prepare(`
    INSERT INTO assistant_names (user_key, kind, heard, target_id, hits, last_at)
    VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(user_key, kind, heard) DO UPDATE SET
      target_id = excluded.target_id,
      hits = CASE WHEN assistant_names.target_id = excluded.target_id THEN assistant_names.hits + 1 ELSE 1 END,
      last_at = CURRENT_TIMESTAMP`);
  for (const it of items.slice(0, 5)) {
    const kind = ['store', 'shop', 'product', 'listing'].includes(it && it.kind) ? it.kind : null;
    const heard = String((it && it.heard) || '').trim().toLowerCase().slice(0, 60);
    const id = parseInt(it && it.id, 10);
    if (!kind || heard.length < 2 || !Number.isInteger(id)) continue;
    up.run(me, kind, heard, id);
  }
}

// POST /api/retail-admin/assistant/plan  { text, via, lang, answers?, learn?, log_id? }
router.post('/api/retail-admin/assistant/plan', requireRetailAdmin, requireAssistant, express.json({ limit: '8kb' }), async (req, res) => {
  if (!assistant.available()) return res.status(503).json({ success: false, error: 'not_configured', message: 'The assistant needs the model key on the server.' });
  const b = req.body || {};
  const text = String(b.text || '').trim();
  if (!text) return res.status(400).json({ success: false, error: 'text_required' });
  const lang = b.lang === 'zh' ? 'zh' : 'en';
  const via = b.via === 'voice' ? 'voice' : 'typed';
  const me = userKey(req);
  const t = tdb();
  // A name the person just explained by answering a question is learned
  // BEFORE the plan, so this plan already reads it.
  if (Array.isArray(b.learn) && b.learn.length) learn(req, b.learn);
  const answers = {};
  if (b.answers && typeof b.answers === 'object') {
    for (const k of ['store_id', 'shop_id', 'product_id', 'listing_id']) {
      const v = parseInt(b.answers[k], 10);
      if (Number.isInteger(v)) answers[k] = v;
    }
  }
  let cat;
  try { cat = assistant.catalogue(t); }
  catch (e) { console.error('[assistant catalogue]', e && e.message); return res.status(500).json({ success: false, error: 'catalogue_failed' }); }
  let plan;
  try {
    plan = await assistant.plan({ text, lang, cat, names: namesFor(req), answers });
  } catch (e) {
    console.error('[assistant plan]', e && e.message, e && e._detail ? e._detail : '');
    return res.status(502).json({ success: false, error: 'model_failed' });
  }
  // The log row: one per sentence, carried on through outcome. A re-plan after
  // a question updates the same row.
  let logId = parseInt(b.log_id, 10);
  const planJson = JSON.stringify({ say: plan.say, actions: plan.actions.map(a => ({ key: a.key, type: a.type, suggested: a.suggested, label_en: a.label_en, action: a.action })), question: plan.question, unknown_names: plan.unknown_names, dropped: plan.dropped, answers });
  try {
    if (Number.isInteger(logId) && t.prepare('SELECT 1 FROM assistant_log WHERE id = ? AND user_key = ?').get(logId, me)) {
      t.prepare('UPDATE assistant_log SET plan_json = ?, outcome = ? WHERE id = ?').run(planJson, plan.question ? 'asked' : 'shown', logId);
    } else {
      const info = t.prepare('INSERT INTO assistant_log (user_key, said, via, lang, plan_json, outcome) VALUES (?, ?, ?, ?, ?, ?)')
        .run(me, text.slice(0, 400), via, lang, planJson, plan.question ? 'asked' : 'shown');
      logId = Number(info.lastInsertRowid);
    }
    t.prepare(`DELETE FROM assistant_log WHERE created_at < datetime('now', '-${KEEP_DAYS} days')`).run();
  } catch (e) { /* the log is never worth a failed plan */ }
  res.json({ success: true, data: { id: logId, say: plan.say, actions: plan.actions, question: plan.question, unknown_names: plan.unknown_names } });
});

// POST /api/retail-admin/assistant/outcome  { id, outcome, approved, results }
router.post('/api/retail-admin/assistant/outcome', requireRetailAdmin, requireAssistant, express.json({ limit: '8kb' }), (req, res) => {
  const b = req.body || {};
  const id = parseInt(b.id, 10);
  const outcome = ['approved', 'declined', 'cancelled'].includes(b.outcome) ? b.outcome : null;
  if (!Number.isInteger(id) || !outcome) return res.status(400).json({ success: false, error: 'nothing_to_change' });
  const approved = Array.isArray(b.approved) ? b.approved.filter(k => typeof k === 'string').slice(0, 50) : [];
  const results = Array.isArray(b.results) ? b.results.slice(0, 50).map(r => ({ key: String(r && r.key || ''), ok: !!(r && r.ok), error: r && r.error ? String(r.error).slice(0, 200) : null })) : [];
  const info = tdb().prepare('UPDATE assistant_log SET outcome = ?, approved_json = ?, results_json = ? WHERE id = ? AND user_key = ?')
    .run(outcome, JSON.stringify(approved), JSON.stringify(results), id, userKey(req));
  res.json({ success: true, data: { changed: info.changes } });
});

// GET /api/retail-admin/assistant/log?days=7 — full access only.
router.get('/api/retail-admin/assistant/log', requireRetailAdmin, requireAssistant, (req, res) => {
  const restricted = !!req.backendUser && (req.backendUser.role === 'kitchen' || req.backendUser.role === 'store_stock');
  if (restricted) return res.status(403).json({ success: false, error: 'full_access_required' });
  const days = Math.min(KEEP_DAYS, Math.max(1, parseInt(req.query.days, 10) || 7));
  const rows = tdb().prepare(`SELECT id, created_at, user_key, said, via, lang, plan_json, outcome, approved_json, results_json
      FROM assistant_log WHERE created_at >= datetime('now', '-' || ? || ' days') ORDER BY created_at DESC, id DESC LIMIT 2000`).all(days);
  const names = {};
  for (const r of rows) {
    if (names[r.user_key] === undefined) {
      const m = /^b:(\d+)$/.exec(r.user_key);
      let u = null;
      try { u = m ? db.prepare('SELECT display_name, username FROM tenant_users WHERE id = ?').get(parseInt(m[1], 10)) : null; } catch (e) { u = null; }
      names[r.user_key] = u ? (u.display_name || u.username || r.user_key) : r.user_key;
    }
    r.user_name = names[r.user_key];
    try { r.plan = r.plan_json ? JSON.parse(r.plan_json) : null; } catch (e) { r.plan = null; }
    try { r.approved = r.approved_json ? JSON.parse(r.approved_json) : null; } catch (e) { r.approved = null; }
    try { r.results = r.results_json ? JSON.parse(r.results_json) : null; } catch (e) { r.results = null; }
    delete r.plan_json; delete r.approved_json; delete r.results_json;
  }
  res.json({ success: true, data: { days, rows } });
});

module.exports = router;
