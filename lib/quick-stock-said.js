// The sentence log behind Quick Stock's microphone — decisions §493 rule 10.
//
// Every sentence said or typed into the sheet is recorded with what the phone
// (or the model) made of it and what the operator then did: confirmed the
// card, went back, picked another product, cancelled. A week of these says
// which half is weak — HEARING (the text itself is wrong) or UNDERSTANDING
// (the text is fine and the card was still wrong) — and that decides whether
// the next step is a speech service with hot words or a better reader. It is
// a log, not a memory: nothing reads it on the way in. Rule 7's
// quick_stock_heard is the memory.
//
// Pure helpers here, so scripts/test_quick_stock_said.js can run them without
// a database; the routes in routes/retail-inventory.js do the SQL.
'use strict';

const OUTCOMES = new Set(['shown', 'no_card', 'confirmed', 'back', 'cancelled']);
const READ_BY = new Set(['phone', 'model', 'none']);
const VIA = new Set(['voice', 'typed']);
const KEEP_DAYS = 90;
const MAX_SAID = 300;

/* A row from what the phone sends, with nothing it should not say. */
function shapeNew(body, userKey) {
  const b = body && typeof body === 'object' ? body : {};
  const int = v => (Number.isInteger(v) ? v : (typeof v === 'string' && /^\d+$/.test(v.trim()) ? parseInt(v, 10) : null));
  const said = String(b.said || '').trim().slice(0, MAX_SAID);
  if (!said) return null;
  const candidates = Array.isArray(b.candidate_ids) ? b.candidate_ids.map(int).filter(v => v != null).slice(0, 5) : [];
  const outcome = OUTCOMES.has(b.outcome) ? b.outcome : 'shown';
  return {
    user_key: userKey,
    said,
    via: VIA.has(b.via) ? b.via : 'typed',
    lang: b.lang === 'en' || b.lang === 'zh' ? b.lang : null,
    read_by: READ_BY.has(b.read_by) ? b.read_by : 'none',
    product_id: int(b.product_id),
    candidate_ids: candidates.length ? JSON.stringify(candidates) : null,
    store_id: int(b.store_id),
    action: b.action === 'set' || b.action === 'add' ? b.action : null,
    qty: (() => { const q = int(b.qty); return q != null && q >= 0 ? q : null; })(),
    outcome: outcome === 'confirmed' || outcome === 'back' || outcome === 'cancelled' ? 'shown' : outcome,
    picked_product_id: null,
  };
}

/* What a later message may change: the outcome, and the product picked when
   the card offered a choice. Returns null when there is nothing to change. */
function shapeOutcome(body) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  if (b.outcome === 'confirmed' || b.outcome === 'back' || b.outcome === 'cancelled') out.outcome = b.outcome;
  const p = Number.isInteger(b.picked_product_id) ? b.picked_product_id
    : (typeof b.picked_product_id === 'string' && /^\d+$/.test(b.picked_product_id) ? parseInt(b.picked_product_id, 10) : null);
  if (p != null) out.picked_product_id = p;
  return Object.keys(out).length ? out : null;
}

/* The week's reading, in one table. `rows` are the log joined to product
   names; the summary counts what matters: how many sentences, how many
   confirmed as read, how many needed a pick (the reader was wrong), how many
   found nothing (the hearing was probably wrong), split by voice and typed
   and by language. */
function summarise(rows) {
  const s = { sentences: 0, confirmed: 0, picked_other: 0, no_card: 0, back_or_cancelled: 0,
    by_model: 0, voice: 0, typed: 0, en: 0, zh: 0 };
  for (const r of rows || []) {
    s.sentences++;
    if (r.outcome === 'confirmed') {
      s.confirmed++;
      if (r.picked_product_id != null && r.picked_product_id !== r.product_id) s.picked_other++;
    } else if (r.outcome === 'no_card') s.no_card++;
    else if (r.outcome === 'back' || r.outcome === 'cancelled') s.back_or_cancelled++;
    if (r.read_by === 'model') s.by_model++;
    if (r.via === 'voice') s.voice++; else s.typed++;
    if (r.lang === 'en') s.en++; else if (r.lang === 'zh') s.zh++;
  }
  return s;
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const CSV_COLUMNS = ['created_at', 'user', 'said', 'via', 'lang', 'read_by', 'card_product', 'card_sku',
  'candidates', 'store', 'action', 'qty', 'outcome', 'picked_product', 'picked_sku'];

/* Rows as a CSV Excel opens, with a BOM so the Chinese reads. */
function toCsv(rows) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows || []) {
    lines.push([r.created_at, r.user_name || r.user_key, r.said, r.via, r.lang, r.read_by,
      r.card_product, r.card_sku, r.candidates, r.store, r.action, r.qty, r.outcome,
      r.picked_product, r.picked_sku].map(csvCell).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/* The statements, in one place, so database.js, the routes and the test run
   the same ones. */
const SQL = {
  create: `
  CREATE TABLE IF NOT EXISTS quick_stock_said (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_key          TEXT    NOT NULL,
    said              TEXT    NOT NULL,
    via               TEXT    NOT NULL DEFAULT 'typed',
    lang              TEXT,
    read_by           TEXT    NOT NULL DEFAULT 'none',
    product_id        INTEGER,
    candidate_ids     TEXT,
    store_id          INTEGER,
    action            TEXT,
    qty               INTEGER,
    outcome           TEXT    NOT NULL DEFAULT 'shown',
    picked_product_id INTEGER,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_quick_stock_said_created ON quick_stock_said (created_at);`,
  insert: `INSERT INTO quick_stock_said
    (user_key, said, via, lang, read_by, product_id, candidate_ids, store_id, action, qty, outcome, picked_product_id)
    VALUES (@user_key, @said, @via, @lang, @read_by, @product_id, @candidate_ids, @store_id, @action, @qty, @outcome, @picked_product_id)`,
  prune: `DELETE FROM quick_stock_said WHERE created_at < datetime('now', '-${KEEP_DAYS} days')`,
  // Only the row's own operator may change its outcome, and only forward from
  // where it is: a confirmed row stays confirmed.
  outcome: `UPDATE quick_stock_said
    SET outcome = COALESCE(@outcome, outcome),
        picked_product_id = COALESCE(@picked_product_id, picked_product_id)
    WHERE id = @id AND user_key = @user_key AND outcome <> 'confirmed'`,
  list: `SELECT s.id, s.created_at, s.user_key, s.said, s.via, s.lang, s.read_by,
           s.product_id, s.candidate_ids, s.store_id, s.action, s.qty, s.outcome, s.picked_product_id,
           p.name_en AS card_product, p.sku AS card_sku,
           q.name_en AS picked_product, q.sku AS picked_sku,
           st.name_en AS store
      FROM quick_stock_said s
      LEFT JOIN store_products p ON p.id = s.product_id
      LEFT JOIN store_products q ON q.id = s.picked_product_id
      LEFT JOIN retail_stores st ON st.id = s.store_id
     WHERE s.created_at >= datetime('now', '-' || @days || ' days')
     ORDER BY s.created_at DESC, s.id DESC
     LIMIT @limit`,
};

module.exports = { shapeNew, shapeOutcome, summarise, toCsv, CSV_COLUMNS, OUTCOMES, KEEP_DAYS, SQL };
