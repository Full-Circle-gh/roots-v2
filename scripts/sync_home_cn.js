#!/usr/bin/env node
// One-shot: bring the HOME-page mini-app CMS blocks' Chinese (_cn) text into
// sync with the English (_en) the admin already filled in. Several blocks had
// stale copy-paste CN or empty CN (which makes the renderer silently fall back
// to English when the mini app is in 中文). This patches only the listed
// _cn fields by block id; every other field is preserved untouched.
//
// Usage:
//   node scripts/sync_home_cn.js --dry        # preview, no write
//   node scripts/sync_home_cn.js              # write draft + publish (draft -> live)
//   node scripts/sync_home_cn.js --draft-only # write draft only, don't publish
//
// Idempotent: re-running produces the same result.

const path = require('path');
const Database = require('better-sqlite3');

const DRAFT_KEY = 'cms.draft.home_layout';
const LIVE_KEY  = 'home.layout';
const BY = 'cn-sync-script';

// blockId -> { fieldPath: cnValue }. fieldPath is dot/bracket notation rooted
// at the block, naming the *_cn key to set. Only fields that were wrong or
// empty are listed; faithful CN already in place is left alone.
const PATCH = {
  // category_tabs — kicker CN was empty
  'bbo701tj': {
    'kicker_cn': '分类',
    'title_cn':  '逛逛菜园',
  },
  // product_grid — kicker/title CN were stale leftovers
  'bk8klcql': {
    'kicker_cn': '热销榜',
    'title_cn':  '跑得最快的',
  },
  // featured_item — kicker CN was a stale leftover
  'b9zut88d': {
    'kicker_cn': '好吃到犯规',
  },
  // coupon_block — title/subtitle CN didn't match the English
  'bplcula8': {
    'title_cn':    '欢迎来到 Roots',
    'subtitle_cn': '新朋友?这单我们请客。满 ¥199 任意订单可用。',
  },
  // recipe_story — headline/body/byline CN were about a different article
  'bldus6if': {
    'headline_cn': '市集现场的 Roots 🌿',
    'byline_cn':   '出品 · Asher(创始人)',
    'body_cn':     '上一次的市集太火爆了——是那种最棒的火爆。\n\n几百份试吃、无数次交流,还有那么多人第一次尝到 Roots。看着大家发现 Roots、提出问题、然后回来再来一份,那种能量太纯粹了。\n\n没有什么比亲眼看到真实的反应更动人了。谢谢每一位驻足、品尝、聊天的朋友,是你们让这一天如此难忘。',
  },
  // affiliate_block — tighten title CN to mirror "Get / Give"
  'bmu7kwca': {
    'title_cn': '送 ¥30,得 ¥30。',
  },
  // review_card — second review CN was empty
  'b0pfxzgj': {
    'reviews[1].quote_cn':          '早在 2006 年 Asher 从自家厨房起步时,我就认识他了。如今的这一切简直令人惊叹。Ash,太牛了!',
    'reviews[1].author_subline_cn': '健康教练 · 营养师',
  },
};

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DRY = process.argv.includes('--dry');
const DRAFT_ONLY = process.argv.includes('--draft-only');
const DB_PATH = arg('--db', path.join(__dirname, '..', 'data', 'roots.db'));

const db = new Database(DB_PATH);

function readLayout(key) {
  const row = db.prepare('SELECT value_json FROM storefront_config WHERE key = ?').get(key);
  if (!row) return null;
  try { const v = JSON.parse(row.value_json); return Array.isArray(v) ? v : null; }
  catch { return null; }
}

// Set a value at a dot/bracket path on an object, creating nothing new — every
// intermediate node must already exist (we only ever target known blocks).
function setPath(obj, pathStr, value) {
  const parts = [];
  pathStr.replace(/[^.[\]]+/g, (m) => { parts.push(m); return m; });
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null) return false;
    cur = cur[parts[i]];
  }
  if (cur == null || typeof cur !== 'object') return false;
  cur[parts[parts.length - 1]] = value;
  return true;
}
function getPath(obj, pathStr) {
  const parts = [];
  pathStr.replace(/[^.[\]]+/g, (m) => { parts.push(m); return m; });
  let cur = obj;
  for (const p of parts) { if (cur == null) return undefined; cur = cur[p]; }
  return cur;
}

let base = readLayout(DRAFT_KEY);
let source = DRAFT_KEY;
if (!base || !base.length) { base = readLayout(LIVE_KEY); source = LIVE_KEY; }
if (!base) { console.error(`No home layout found (neither ${DRAFT_KEY} nor ${LIVE_KEY}).`); process.exit(1); }

console.log(`DB: ${DB_PATH}`);
console.log(`Base layout: ${source} (${base.length} blocks)\n`);

const byId = new Map(base.map(b => [b.id, b]));
let changed = 0;
for (const [id, fields] of Object.entries(PATCH)) {
  const block = byId.get(id);
  if (!block) { console.log(`! block ${id} not found — skipped`); continue; }
  console.log(`• ${block.type} (${id})`);
  for (const [fp, val] of Object.entries(fields)) {
    const before = getPath(block, fp);
    if (before === val) { console.log(`    ${fp}: (already correct)`); continue; }
    const ok = setPath(block, fp, val);
    if (!ok) { console.log(`    ${fp}: ! path missing — skipped`); continue; }
    changed++;
    const b = before == null ? '∅' : JSON.stringify(String(before).slice(0, 40));
    console.log(`    ${fp}: ${b} → ${JSON.stringify(val.slice(0, 40))}`);
  }
}

console.log(`\n${changed} field(s) would change.`);
if (DRY) { console.log('\n--dry: nothing written.'); process.exit(0); }

const json = JSON.stringify(base);
function write(key) {
  db.prepare(
    `INSERT INTO storefront_config (key, value_json, updated_at, updated_by)
     VALUES (?, ?, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = CURRENT_TIMESTAMP,
       updated_by = excluded.updated_by`
  ).run(key, json, BY);
}

write(DRAFT_KEY);
console.log(`\nWrote DRAFT → ${DRAFT_KEY}.`);
if (!DRAFT_ONLY) {
  write(LIVE_KEY);
  console.log(`Published → ${LIVE_KEY} (live).`);
} else {
  console.log('--draft-only: not published. Review in /cms and hit Publish.');
}
