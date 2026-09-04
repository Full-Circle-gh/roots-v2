// SKU rules — the database half of automatic SKU generation.
//
// lib/sku-format.js renders a pattern. This file answers the two questions a
// pattern cannot answer on its own: WHICH pattern applies to the thing being
// saved, and WHAT running number it gets. Both live in the tenant's own
// database, so every tenant numbers its catalogue its own way and Roots is not
// a special case anywhere in here.
//
// THREE LEVELS, MOST SPECIFIC WINS:
//
//   (kind, category)  →  the rule for Food ▸ Dried fruits
//   (kind, '')        →  the rule for everything under Food
//   ('', '')          →  the tenant's default rule
//
// The wildcard is the EMPTY STRING, never NULL. SQLite treats NULLs as
// distinct, so a UNIQUE(entity_type, category, subcategory) index over
// nullable columns would happily accept five "default" rules; '' makes the
// uniqueness real.
//
// NAMING. Materials have two levels today — `ingredients.item_kind` (Food,
// Packaging, …) and `ingredients.category` (Dried fruits) — so `category` here
// holds the KIND and `subcategory` holds the material's category column. That
// is the mapping Ash chose (2026-09-04): it uses the two levels the catalogue
// already has rather than adding a third field nobody has filled in. When
// recipes and products follow, their own two levels slot into the same pair.
//
// WHERE THE NUMBER RESTARTS. The counter is keyed by the rule that MATCHED, not
// by the item's own category. Give Dried fruits its own rule and dried fruits
// get their own series; leave it to the Food rule and everything under Food
// shares one. This is why per-subcategory numbering needs no separate setting —
// it is what defining a rule at that level MEANS. A generated code is never
// reused: nothing decrements a counter, and archiving keeps the SKU (§18).

'use strict';

const fmt = require('./sku-format');

// One entry per record type the engine can number. Only materials are wired
// today (Ash, 2026-09-04: "we start with material first and see how it goes");
// recipes and products are listed as the shape the next slice fills in, NOT as
// working entries — nothing resolves them until their routes call in.
const ENTITIES = {
  material: {
    table: 'ingredients',
    column: 'sku',
    label_en: 'Materials', label_cn: '物料',
    // The two columns whose values feed (category, subcategory) above.
    levels: { category: 'item_kind', subcategory: 'category' },
  },
};

// The fallback rule's shape. It renders its prefix through {CAT} rather than as
// a literal "GEN" so the settings screen's plain controls can describe it like
// any other rule — a fallback the operator cannot edit without meeting a
// formula is exactly the thing this design removes.
const DEFAULT_PATTERN = '{CAT}-{SEQ:4}';
const DEFAULT_CODE = 'GEN';

function entityConf(entity) {
  const e = ENTITIES[entity];
  if (!e) throw new Error(`[sku-rules] unknown entity "${entity}"`);
  return e;
}

// Every read and write below normalises through these two, so a rule saved as
// "  Dried Fruits " and a material carrying "dried fruits" still meet. The
// stored form keeps the operator's capitalisation (it is shown back to them);
// only the COMPARISON is case-folded, via the key helpers.
const norm = s => String(s == null ? '' : s).trim();
const key = s => norm(s).toLowerCase();

// ── settings ────────────────────────────────────────────────────────────────
// One row per entity. Absent means "on with the default pattern" — a fresh
// tenant should not have to visit a settings screen before its first material
// gets a code, and a blank SKU is the thing this feature exists to remove.
function getSettings(db, entity) {
  entityConf(entity);
  let row = null;
  try { row = db.prepare('SELECT * FROM sku_settings WHERE entity_type = ?').get(entity); } catch (_) { /* table not created yet */ }
  return {
    entity_type: entity,
    enabled: row ? !!row.enabled : true,
    updated_at: row ? row.updated_at : null,
  };
}

function setSettings(db, entity, { enabled }) {
  entityConf(entity);
  db.prepare(`INSERT INTO sku_settings (entity_type, enabled, updated_at)
              VALUES (?,?,CURRENT_TIMESTAMP)
              ON CONFLICT(entity_type) DO UPDATE SET enabled = excluded.enabled, updated_at = CURRENT_TIMESTAMP`)
    .run(entity, enabled ? 1 : 0);
  return getSettings(db, entity);
}

// ── rules ───────────────────────────────────────────────────────────────────
function listRules(db, entity) {
  entityConf(entity);
  return db.prepare(
    `SELECT * FROM sku_rules WHERE entity_type = ?
      ORDER BY (category = '') DESC, category, (subcategory = '') DESC, subcategory`
  ).all(entity);
}

// The rule an item with this (category, subcategory) is numbered by. Returns
// null only when nothing matches AND no default row exists — callers treat that
// as "leave the SKU alone", never as an error.
function resolveRule(db, entity, category, subcategory) {
  entityConf(entity);
  const rules = listRules(db, entity).filter(r => r.is_active);
  const c = key(category);
  const s = key(subcategory);
  return (
    rules.find(r => key(r.category) === c && key(r.subcategory) === s && s !== '') ||
    rules.find(r => key(r.category) === c && key(r.subcategory) === '' && c !== '') ||
    rules.find(r => key(r.category) === '' && key(r.subcategory) === '') ||
    null
  );
}

// The codes {CAT} and {SUB} render. {CAT} comes from the category-level rule
// even when a subcategory rule matched — otherwise `{CAT}{SUB}` would need the
// letter typed twice, on every subcategory, forever.
function codesFor(db, entity, category, subcategory, matched) {
  const rules = listRules(db, entity);
  const c = key(category);
  const catRule = rules.find(r => key(r.category) === c && key(r.subcategory) === '' && c !== '');
  const subRule = rules.find(r => key(r.category) === c && key(r.subcategory) === key(subcategory) && key(subcategory) !== '');
  return {
    categoryCode: norm(catRule && catRule.code) || (matched && key(matched.subcategory) === '' ? norm(matched.code) : ''),
    subcategoryCode: norm(subRule && subRule.code) || (matched && key(matched.subcategory) !== '' ? norm(matched.code) : ''),
  };
}

function saveRule(db, entity, input) {
  entityConf(entity);
  const category = norm(input.category);
  const subcategory = norm(input.subcategory);
  if (!category && subcategory) {
    return { ok: false, error: 'subcategory_needs_category' };
  }
  const codeCheck = fmt.validateCode(input.code);
  if (!codeCheck.ok) return { ok: false, error: codeCheck.error };

  // TWO WAYS IN, ONE STORED FORM. The settings screen sends `simple` — the four
  // plain controls an operator actually sees — and the pattern is composed
  // here; its Advanced field sends a `pattern` directly. Composing server-side
  // is what keeps the braces off that screen without inventing a second stored
  // format for everything downstream to learn.
  const scope = subcategory ? 'subcategory' : (category ? 'category' : 'default');
  const pattern = input.simple
    ? fmt.fromSimple(input.simple, scope)
    : (norm(input.pattern) || DEFAULT_PATTERN);
  const v = fmt.validate(pattern);
  if (!v.ok) return { ok: false, error: 'bad_pattern', detail: v.errors };

  const existing = db.prepare(
    'SELECT * FROM sku_rules WHERE entity_type = ? AND lower(category) = ? AND lower(subcategory) = ?'
  ).get(entity, key(category), key(subcategory));

  if (existing) {
    db.prepare(`UPDATE sku_rules SET category=?, subcategory=?, code=?, pattern=?, is_active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(category, subcategory, codeCheck.value, pattern, input.is_active === 0 ? 0 : 1, existing.id);
    return { ok: true, id: existing.id, warnings: v.warnings };
  }
  const r = db.prepare(`INSERT INTO sku_rules (entity_type, category, subcategory, code, pattern, is_active)
                        VALUES (?,?,?,?,?,?)`)
    .run(entity, category, subcategory, codeCheck.value, pattern, input.is_active === 0 ? 0 : 1);
  return { ok: true, id: r.lastInsertRowid, warnings: v.warnings };
}

function deleteRule(db, entity, id) {
  entityConf(entity);
  const row = db.prepare('SELECT * FROM sku_rules WHERE id = ? AND entity_type = ?').get(id, entity);
  if (!row) return { ok: false, error: 'not_found' };
  // The default row is the fallback every unruled category lands on. Deleting
  // it would silently stop numbering things, so it is reset instead of removed.
  if (norm(row.category) === '' && norm(row.subcategory) === '') {
    db.prepare('UPDATE sku_rules SET pattern = ?, code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(DEFAULT_PATTERN, DEFAULT_CODE, id);
    return { ok: true, reset: true };
  }
  db.prepare('DELETE FROM sku_rules WHERE id = ?').run(id);
  return { ok: true };
}

// ── counters ────────────────────────────────────────────────────────────────
// scope_key identifies the rule that matched, case-folded so a renamed
// capitalisation does not start the series again.
function scopeKey(rule) {
  return key(rule.category) + '|' + key(rule.subcategory);
}

function peekSeq(db, entity, rule) {
  const row = db.prepare('SELECT next_seq FROM sku_counters WHERE entity_type = ? AND scope_key = ?')
    .get(entity, scopeKey(rule));
  return row ? row.next_seq : 1;
}

function bumpSeq(db, entity, rule, to) {
  db.prepare(`INSERT INTO sku_counters (entity_type, scope_key, next_seq, updated_at)
              VALUES (?,?,?,CURRENT_TIMESTAMP)
              ON CONFLICT(entity_type, scope_key) DO UPDATE SET next_seq = excluded.next_seq, updated_at = CURRENT_TIMESTAMP`)
    .run(entity, scopeKey(rule), to);
}

// Is this code already on a row of the entity's own table? Archived rows count:
// their SKUs are kept on purpose (§18), so reusing one would point old orders
// at the wrong thing.
function skuTaken(db, entity, sku) {
  const e = entityConf(entity);
  const row = db.prepare(`SELECT 1 FROM ${e.table} WHERE ${e.column} = ?`).get(sku);
  return !!row;
}

// ── the two public answers ──────────────────────────────────────────────────

// What the NEXT code would be, without claiming it. This is what the material
// form shows greyed-out beside the SKU field while the operator is still
// typing: an abandoned form must not burn a number, so nothing is written here.
function peek(db, entity, { category, subcategory, name, date } = {}) {
  entityConf(entity);
  const settings = getSettings(db, entity);
  if (!settings.enabled) return { ok: false, reason: 'disabled' };
  const rule = resolveRule(db, entity, category, subcategory);
  if (!rule) return { ok: false, reason: 'no_rule' };
  const codes = codesFor(db, entity, category, subcategory, rule);
  const seq = peekSeq(db, entity, rule);
  const sku = fmt.render(rule.pattern, { ...codes, seq, name, date: date || new Date() });
  return {
    ok: true,
    sku,
    seq,
    rule: { id: rule.id, category: rule.category, subcategory: rule.subcategory, pattern: rule.pattern, code: rule.code },
    // A regex the material form tests a HAND-TYPED code against, so it can say
    // "this does not look like a Dried fruits code" without refusing the save.
    // Built here rather than in the browser so the matcher and the renderer
    // can never disagree about what a token means.
    match_re: fmt.matchRegexSource(rule.pattern, codes),
    // Which level answered, so the screen can say "using the Food rule" rather
    // than leaving the operator to guess why Dried fruits got a Food code.
    matched: norm(rule.subcategory) ? 'subcategory' : (norm(rule.category) ? 'category' : 'default'),
  };
}

// Claim the next free code and advance the counter. Call INSIDE the caller's
// own transaction where one exists — better-sqlite3 transactions nest as
// savepoints, so the counter advance and the row insert commit or roll back
// together and a failed save leaves no gap.
//
// The retry loop is not paranoia. Two rules can render the same string (two
// subcategories both patterned `B{SEQ:4}`), and a catalogue full of hand-typed
// SKUs can already own the code a fresh counter is about to produce. Rather
// than fail the save, walk forward to the first free one.
function claim(db, entity, { category, subcategory, name, date } = {}) {
  entityConf(entity);
  const settings = getSettings(db, entity);
  if (!settings.enabled) return { ok: false, reason: 'disabled' };
  const rule = resolveRule(db, entity, category, subcategory);
  if (!rule) return { ok: false, reason: 'no_rule' };
  const codes = codesFor(db, entity, category, subcategory, rule);
  const when = date || new Date();

  let seq = peekSeq(db, entity, rule);
  let last = null;
  for (let tries = 0; tries < 200; tries++) {
    const candidate = fmt.render(rule.pattern, { ...codes, seq, name, date: when });
    if (candidate && !skuTaken(db, entity, candidate)) {
      bumpSeq(db, entity, rule, seq + 1);
      return { ok: true, sku: candidate, seq, rule_id: rule.id };
    }
    // A pattern with no {SEQ} renders the same string every time, so bumping
    // the counter would loop forever. Suffix instead — validate() already
    // warned the operator that this pattern cannot number anything.
    if (candidate === last) {
      for (let n = 2; n < 1000; n++) {
        const suffixed = (candidate + '-' + n).slice(0, fmt.MAX_SKU);
        if (!skuTaken(db, entity, suffixed)) {
          bumpSeq(db, entity, rule, seq + 1);
          return { ok: true, sku: suffixed, seq, rule_id: rule.id };
        }
      }
      return { ok: false, reason: 'exhausted' };
    }
    last = candidate;
    seq += 1;
  }
  return { ok: false, reason: 'exhausted' };
}

module.exports = {
  ENTITIES, DEFAULT_PATTERN, DEFAULT_CODE,
  getSettings, setSettings,
  listRules, resolveRule, saveRule, deleteRule,
  peek, claim,
  // exported for the tests and for the settings screen's "reset numbering"
  peekSeq, bumpSeq, scopeKey,
};
