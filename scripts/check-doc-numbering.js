#!/usr/bin/env node
/**
 * check-doc-numbering.js — two append-only documents, four structural rules.
 *
 *   node scripts/check-doc-numbering.js
 *
 * WHY THIS EXISTS, and it is one specific failure rather than a general tidiness
 * wish. On 2026-09-07 two open PRs each wrote `v4.139` into the header line of
 * `docs/tacet-consolidation-decisions.md`. Git merged them WITHOUT A CONFLICT,
 * because a three-way merge only conflicts when the two sides change a line to
 * DIFFERENT text — both sides had changed it to the same bytes, which git reads
 * as agreement. The duplicate reached main and was found by a person reading the
 * changelog. Nothing in the repository was watching: at the time this was
 * written, `docs/tacet-consolidation-decisions.md` was not read by a single
 * test, script, route or workflow — its only programmatic mention anywhere was
 * inside a SQL comment in `lib/channel-drift-sweep.js`.
 *
 * THE IDENTICAL-VALUE COLLISION IS THE WORST CASE, which is the whole reason a
 * check is needed rather than better habits. When two branches claim the same
 * number with DIFFERENT surrounding prose, git conflicts and a human resolves
 * it; that is what happened to §52/§53/§54 the same day and it was noisy and
 * safe. When they claim it with identical bytes, the merge is silent. The loud
 * case looks after itself. This is for the quiet one.
 *
 * THE SECOND-ORDER HOLE THIS ALSO CLOSES. Section numbers had never been checked
 * either, and that collision has happened four recorded times: two branches each
 * defining a §39, then §46/§47, then §53 (PR #336, renumbered on rebase), then
 * §55–§57 (PR #328, likewise). Every one was caught by a person. The document
 * records each occurrence faithfully, which is the signature of a recurring
 * failure nobody had automated away.
 *
 * ── WHAT IS ASSERTED, PER FILE ──────────────────────────────────────────────
 *
 *   1. No changelog version appears twice.
 *   2. The header version equals the highest version in the changelog.
 *   3. Section numbers are unique.
 *   4. The highest section number is the last one in the file.
 *
 * ── WHAT IS DELIBERATELY *NOT* ASSERTED ─────────────────────────────────────
 *
 * SECTIONS ARE NOT REQUIRED TO BE SEQUENTIAL, and the decisions document would
 * fail such a check today while being entirely correct. Its own numbering rule,
 * quoted from its head, is:
 *
 *   "Section numbers are permanent. New sections append to the end and take the
 *    next number, wherever Related documents happens to sit. No section is ever
 *    renumbered, for any reason. A number in this file is a citation target and
 *    must stay valid."
 *
 * So `Related documents` is §38 with nineteen sections after it, and §0 and §0.1
 * both exist at the top. A contiguity check would produce false failures against
 * a rule the file states explicitly, and a check that cries wolf is a check that
 * gets switched off. Rules 3 and 4 above are what the numbering rule actually
 * implies: numbers are unique (a citation target resolves to one place) and new
 * ones append at the end (so the largest is last).
 *
 * DATES ARE NOT ASSERTED to be ordered. The changelog carries deliberate
 * out-of-order dated entries, and nothing depends on their sequence.
 *
 * ── TWO STRUCTURAL FACTS THAT DROVE THE PARSER ──────────────────────────────
 *
 * THE TWO FILES DO NOT SHARE A CHANGELOG FORMAT, so the patterns are per-file
 * rather than one clever regex:
 *
 *   decisions   `2026-09-07 · v4.141 — ...`   date first, at line start
 *   vocabulary  `**v1.25 · 2026-09-07 · ...`  version first, mid-paragraph
 *
 * The vocabulary document keeps its WHOLE changelog inside one paragraph, older
 * versions embedded inline, so its entries cannot be anchored to line starts.
 *
 * ANCHORING IS NOT OPTIONAL, and a naive `v\d+\.\d+` scan is actively wrong. The
 * vocabulary file contains five version tokens that are NOT its own changelog
 * entries: `v1.2`, `v1.3` and `v1.4` are prose back-references written as
 * `v1.3, 2026-08-26, adds it`, and `v4.113` and `v4.118` are versions of the
 * DECISIONS document cited in its prose. Counting those would report duplicates
 * that do not exist and versions belonging to another file. Each pattern below
 * therefore requires the separator that only a real entry carries.
 *
 * SCOPE ADMITTED: rule 1 covers versions written in ENTRY form. The vocabulary
 * document's oldest versions survive only as prose back-references and are not
 * counted. That is not a gap worth closing — nothing appends in that form any
 * more, so nothing can collide there.
 *
 * A FILE THAT DOES NOT NUMBER ITS SECTIONS SAYS SO, AND IS VERIFIED. The
 * vocabulary document's headings are topic titles (`## Rules`, `## Time
 * labels`) with no numbers at all, so rules 3 and 4 have no subject there. It is
 * configured `sections: null` — and that is then ASSERTED rather than skipped:
 * if a numbered heading ever appears in it, this fails and asks for the config
 * to be updated. A silent skip is the same class of hole as the one this file
 * exists to close.
 *
 * VERSIONS ARE COMPARED COMPONENT-WISE, NEVER AS FLOATS. `4.141` and `4.99` are
 * the live trap: as numbers 4.141 < 4.99, as versions 141 > 99. parseFloat here
 * would silently invert the ordering of the highest-version check and let a
 * regression through while reporting green.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ── The two documents, and how each writes its numbers ──────────────────────
// `entry` and `header` must both carry the separator a real entry has — see
// ANCHORING above. `sections: null` means "this document does not number its
// sections", which is asserted rather than assumed.
const DOCS = [
  {
    file: 'docs/tacet-consolidation-decisions.md',
    // `# Tacet shared-core consolidation — decisions record, v4.141`
    header:   /^#\s.*?,\s*v(?<version>\d+\.\d+)\s*$/m,
    // `2026-09-07 · v4.141 — **§44's "ORDER SOURCE" IS NAMED...`
    // Anchored to a line start AND requiring the trailing em dash. The oldest
    // entries use v1.0/v2.x/v3.x forms and are matched too; they are real
    // entries and their uniqueness is worth holding.
    entry:    /^\d{4}-\d{2}-\d{2} · v(?<version>\d+\.\d+) —/gm,
    // BOTH LIVE HEADING FORMS, and accepting only one was a real defect caught
    // on 2026-09-07 before this shipped:
    //
    //   `## 14. Channels`      · `## 0.1 Domains and app structure`
    //   `## §58 — A FRESH LINE ON AN ORDER THAT IS NOT GOING OUT TODAY...`
    //
    // The second form is what the most recent sections use. A pattern matching
    // only the first reported "the highest section is §57" while §58, §59 and
    // §60 sat in the file unread — a GREEN result with a blind spot exactly
    // where new sections land, which is the one place this check has to see.
    //
    // The `no sections matched` guard below does not catch that: it fires at
    // zero, and this was a PARTIAL match. So the pattern reads the file as it
    // actually is rather than as one convention says it should be. The optional
    // `§`, and the alternation of `.` `—` or nothing, are what span both:
    // `## 0. Governing rules` (dot), `## 0.1 Domains` (bare space), and
    // `## §58 — TITLE` (section sign, em dash).
    sections: /^## §?(\d+(?:\.\d+)?)(?:\.|\s+—)?\s/gm,
  },
  {
    file: 'docs/tacet-delivery-vocabulary.md',
    // `**v1.25 · 2026-09-07 · adds *The two doors into a shop...`
    header:   /\*\*v(?<version>\d+\.\d+) · \d{4}-\d{2}-\d{2} ·/,
    // Same shape, found anywhere: this document's changelog is one paragraph.
    entry:    /\bv(?<version>\d+\.\d+) · \d{4}-\d{2}-\d{2} ·/g,
    // Headings here are topic titles, never numbered. Asserted below.
    sections: null,
  },
];

let failures = 0;
const fail = (file, msg, detail) => {
  failures++;
  console.log(`  ✗ [${file}] ${msg}`);
  if (detail) console.log(`      ${detail}`);
};
const pass = (msg) => console.log(`  ✓ ${msg}`);

// Component-wise integer comparison. NEVER parseFloat — see the header note.
// Returns <0, 0, >0 like a sort comparator.
function cmpNumbered(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Line numbers where a value appears AS THE THING BEING CHECKED, so a failure
// says where to look. Matching on the bare token instead would also report the
// header line, which legitimately carries the same version and is not one of
// the duplicates — a diagnostic that sends the reader to an innocent line is
// worse than a terse one.
function linesMatching(src, re, value) {
  const out = [];
  src.split('\n').forEach((l, i) => {
    for (const m of l.matchAll(new RegExp(re.source, re.flags.replace('g', '') + 'g'))) {
      if ((m.groups ? m.groups.version : m[1]) === value) { out.push(i + 1); break; }
    }
  });
  return out;
}

function checkDoc(doc) {
  const abs = path.join(ROOT, doc.file);
  if (!fs.existsSync(abs)) {
    fail(doc.file, 'file not found — this check names a document that no longer exists',
         'Either restore the path or remove it from DOCS in this file.');
    return;
  }
  const src = fs.readFileSync(abs, 'utf8');
  console.log(`\n${doc.file}`);

  // ── 1 · no changelog version appears twice ────────────────────────────────
  // Named group, not a positional one: the two files put the version in a
  // different position (date-first vs version-first) and reading m[1] from both
  // silently yields a DATE for one of them. That bug produced a confident green
  // on the vocabulary file and twenty nonsense "duplicate version" failures on
  // the decisions file the first time this ran.
  const entries = [...src.matchAll(doc.entry)].map((m) => m.groups.version);
  if (entries.length === 0) {
    fail(doc.file, 'no changelog entries matched — the parser has drifted from the file',
         'A green result from a pattern that matches nothing is worse than a red one.');
  } else {
    const seen = new Map();
    for (const v of entries) seen.set(v, (seen.get(v) || 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1);
    if (dupes.length) {
      for (const [v, n] of dupes) {
        fail(doc.file, `version v${v} appears ${n} times in the changelog`,
             `lines ${linesMatching(src, doc.entry, v).join(', ')} — two branches almost certainly `
             + 'claimed it independently. Renumber the later one to the next free version.');
      }
    } else {
      pass(`${entries.length} changelog entries, no version claimed twice`);
    }
  }

  // ── 2 · the header version equals the highest entry version ───────────────
  const hm = src.match(doc.header);
  if (!hm) {
    fail(doc.file, 'no version found in the header line', 'The header pattern no longer matches.');
  } else if (entries.length) {
    const declared = hm.groups.version;
    const highest  = entries.slice().sort(cmpNumbered).pop();
    if (cmpNumbered(declared, highest) !== 0) {
      fail(doc.file, `the header says v${declared} but the highest changelog entry is v${highest}`,
           'The header is what a reader trusts; an entry added without bumping it — or a bump '
           + 'without an entry — leaves the two disagreeing.');
    } else {
      pass(`the header (v${declared}) matches the highest changelog entry`);
    }
  }

  // ── 3 & 4 · section numbers ───────────────────────────────────────────────
  if (doc.sections === null) {
    // Not a skip: assert the premise, or the config goes stale in silence.
    const anyNumbered = [...src.matchAll(/^## §?(\d+(?:\.\d+)?)(?:\.|\s+—)?\s/gm)];
    if (anyNumbered.length) {
      fail(doc.file, `configured as having no numbered sections, but ${anyNumbered.length} were found`,
           `first: "## ${anyNumbered[0][1]}" — give this file a sections pattern in DOCS `
           + 'rather than leaving it unchecked.');
    } else {
      pass('no numbered sections, as configured — headings here are topic titles');
    }
    return;
  }

  const secs = [...src.matchAll(doc.sections)].map((m) => m[1]);
  if (secs.length === 0) {
    fail(doc.file, 'no sections matched — the parser has drifted from the file');
    return;
  }

  const seenSec = new Map();
  for (const s of secs) seenSec.set(s, (seenSec.get(s) || 0) + 1);
  const dupeSec = [...seenSec.entries()].filter(([, n]) => n > 1);
  if (dupeSec.length) {
    for (const [s, n] of dupeSec) {
      fail(doc.file, `section §${s} is defined ${n} times`,
           `lines ${linesMatching(src, doc.sections, s).join(', ')} — `
           + 'a section number is a citation target and must resolve to one place. '
           + 'Two branches each took the next free number while both were open; '
           + 'renumber the later one and move its cross-references with it.');
    }
  } else {
    pass(`${secs.length} sections, every number unique`);
  }

  // The numbering rule says new sections APPEND and take the next number, so
  // the largest must be the last one written. This is the contiguity check's
  // honest replacement: it catches a section inserted in the middle with a
  // number above its neighbours, without demanding a sequence the file has
  // never had and its own rule forbids restoring.
  const last    = secs[secs.length - 1];
  const highest = secs.slice().sort(cmpNumbered).pop();
  if (cmpNumbered(last, highest) !== 0) {
    fail(doc.file, `the last section is §${last} but the highest number is §${highest}`,
         'New sections append to the end and take the next number. A higher number '
         + 'earlier in the file means one was inserted rather than appended.');
  } else {
    pass(`the highest section (§${highest}) is the last one in the file`);
  }
}

console.log('Append-only document numbering — versions and sections');
for (const doc of DOCS) checkDoc(doc);

console.log(failures
  ? `\nFAIL — ${failures} problem(s). See docs/tacet-consolidation-decisions.md, "HOW THIS FILE IS NUMBERED".`
  : '\nPASS — every version and every section number is unique, and both files end where they should.');
process.exit(failures ? 1 : 0);
