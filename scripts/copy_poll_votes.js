#!/usr/bin/env node
/**
 * Copy the CACHED vote counts from one poll onto another, so a freshly-created
 * poll inherits an older poll's statistics.
 *
 * Why: the operator wants to retire an old "showing the tallies" poll and
 * replace it with a brand-new poll that looks established but does NOT reveal
 * its numbers on the currently-published mini-app (which predates the
 * "Show vote counts" toggle, commit a554e94). The published bundle only renders
 * tallies when `showResults = (the viewer has voted) || (poll is closed)`. A new
 * OPEN poll has an EMPTY vote ledger, so every customer is "hasn't voted" → the
 * app hides all numbers until they personally vote. By copying only the cached
 * counts (retail_polls.total_votes + retail_poll_options.votes) — and NOT the
 * retail_poll_votes ledger — the new poll shows nothing now, yet displays the
 * inherited totals (e.g. 17, Roasted Red Pepper leading) the moment someone votes.
 *
 * What it copies:  total_votes (poll) + votes (each option, matched by label_en).
 * What it does NOT touch:  the retail_poll_votes ledger (kept empty on the target
 *   so customers stay "unvoted" and can vote fresh), points, or any other column.
 *
 * Source/target detection (all overridable):
 *   --question "<substr>"  question_en substring to find the pair (default: "hummus")
 *   --from <id>            source poll id (else: matching poll with the MOST votes)
 *   --to   <id>            target poll id (else: matching poll with ZERO votes)
 *   --draft-source         also hide the old poll by setting its status='draft'
 *
 * Safe by default: prints a plan and changes NOTHING unless --apply is passed.
 * On --apply it first backs up data/roots.db.
 *
 * Run ON THE SERVER, against data/roots.db:
 *   node scripts/copy_poll_votes.js                       # dry-run, auto-detect
 *   node scripts/copy_poll_votes.js --to 42 --apply       # copy into poll 42
 *   node scripts/copy_poll_votes.js --from 7 --to 42 --draft-source --apply
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const DRAFT_SOURCE = argv.includes('--draft-source');
function flag(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const QUESTION = flag('--question', 'hummus');
const FROM_ID = flag('--from', null);
const TO_ID = flag('--to', null);

const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');
const db = new Database(DB_PATH);

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

function loadPoll(id) {
  const p = db.prepare('SELECT * FROM retail_polls WHERE id = ?').get(id);
  if (!p) return null;
  p.options = db.prepare(
    'SELECT id, label_en, label_cn, votes, sort_order FROM retail_poll_options WHERE poll_id = ? ORDER BY sort_order, id'
  ).all(id);
  return p;
}

// ── Resolve source + target ────────────────────────────────────────────────
let source, target;

if (FROM_ID) source = loadPoll(parseInt(FROM_ID, 10));
if (TO_ID) target = loadPoll(parseInt(TO_ID, 10));

if (!source || !target) {
  const candidates = db.prepare(
    "SELECT * FROM retail_polls WHERE LOWER(question_en) LIKE ? ORDER BY id"
  ).all(`%${QUESTION.toLowerCase()}%`).map(p => loadPoll(p.id));

  console.log(`\nPolls matching question ~ "${QUESTION}":`);
  for (const p of candidates) {
    console.log(`  #${p.id}  [${p.status}]  total_votes=${p.total_votes}  "${p.question_en}"  (${p.options.length} opts)`);
  }

  if (!source) {
    const withVotes = candidates.filter(p => p.total_votes > 0).sort((a, b) => b.total_votes - a.total_votes);
    if (withVotes.length !== 1) {
      console.error(`\n[abort] Could not auto-pick a SINGLE source (found ${withVotes.length} polls with votes). Pass --from <id>.`);
      process.exit(1);
    }
    source = withVotes[0];
  }
  if (!target) {
    const empty = candidates.filter(p => p.total_votes === 0 && p.id !== source.id);
    if (empty.length !== 1) {
      console.error(`\n[abort] Could not auto-pick a SINGLE empty target (found ${empty.length} zero-vote polls). Create the new poll first, then pass --to <id>.`);
      process.exit(1);
    }
    target = empty[0];
  }
}

if (!source) { console.error('[abort] source poll not found.'); process.exit(1); }
if (!target) { console.error('[abort] target poll not found.'); process.exit(1); }
if (source.id === target.id) { console.error('[abort] source and target are the same poll.'); process.exit(1); }

// ── Match options by label_en and build the copy plan ───────────────────────
const srcByLabel = new Map(source.options.map(o => [norm(o.label_en), o]));
const plan = [];
const unmatched = [];
for (const t of target.options) {
  const s = srcByLabel.get(norm(t.label_en));
  if (!s) { unmatched.push(t); continue; }
  plan.push({ targetOptId: t.id, label: t.label_en, from: t.votes, to: s.votes });
}

console.log(`\nSOURCE  #${source.id}  [${source.status}]  total_votes=${source.total_votes}  "${source.question_en}"`);
console.log(`TARGET  #${target.id}  [${target.status}]  total_votes=${target.total_votes}  "${target.question_en}"`);
console.log('\nOption copy plan (matched by English label):');
for (const p of plan) console.log(`  "${p.label}"   votes ${p.from} → ${p.to}`);

if (unmatched.length) {
  console.error('\n[abort] These TARGET options have no label match in the source — fix the labels so they match exactly, then re-run:');
  for (const u of unmatched) console.error(`  "${u.label_en}"`);
  process.exit(1);
}
const sourceUnmatched = source.options.filter(s => !target.options.some(t => norm(t.label_en) === norm(s.label_en)));
if (sourceUnmatched.length) {
  console.error('\n[abort] These SOURCE options are not present on the target — add them (same English label) so nothing is lost:');
  for (const u of sourceUnmatched) console.error(`  "${u.label_en}" (votes ${u.votes})`);
  process.exit(1);
}

const newTotal = plan.reduce((n, p) => n + p.to, 0);
console.log(`\nTARGET total_votes  ${target.total_votes} → ${newTotal}`);
if (DRAFT_SOURCE) console.log(`SOURCE #${source.id} status  ${source.status} → draft  (hidden from customers)`);

if (!APPLY) {
  console.log('\n[dry-run] Nothing written. Re-run with --apply to commit.\n');
  process.exit(0);
}

// ── Apply (with backup) ─────────────────────────────────────────────────────
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.join(path.dirname(DB_PATH), `roots-prepollcopy-${ts}.db`);
fs.copyFileSync(DB_PATH, backup);
console.log(`\n[copy] backup written: ${backup}`);

const setOpt = db.prepare('UPDATE retail_poll_options SET votes = ? WHERE id = ?');
const setTotal = db.prepare('UPDATE retail_polls SET total_votes = ? WHERE id = ?');
const setStatus = db.prepare("UPDATE retail_polls SET status = 'draft' WHERE id = ?");
const tx = db.transaction(() => {
  for (const p of plan) setOpt.run(p.to, p.targetOptId);
  setTotal.run(newTotal, target.id);
  if (DRAFT_SOURCE) setStatus.run(source.id);
});
tx();

console.log(`[copy] done. Target poll #${target.id} now shows total_votes=${newTotal}.`);
console.log(`[copy] Restore if needed:  cp "${backup}" "${DB_PATH}"  (then restart the app)\n`);
