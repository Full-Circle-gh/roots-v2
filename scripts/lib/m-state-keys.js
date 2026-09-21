/**
 * The app has ONE state object and ~120 keys on it. This finds the two ways
 * that goes wrong silently.
 *
 * WHY IT IS A MODULE AND NOT A BLOCK INSIDE A SUITE. It was a block inside
 * test_mobile_screens.js, which drives Chromium and therefore lives in the slow
 * shard — the shard this repo does not run (CLAUDE.md, and .github/workflows/
 * tests.yml's header). It caught three keys §181 never declared, correctly, on
 * the day they landed, and said so to nobody for three days. A check that costs
 * milliseconds and needs no browser has no business being reachable only
 * through one that costs twelve minutes.
 *
 * So the logic lives here and has two callers: scripts/test_mobile_state_keys.js,
 * which is in the gate, and test_mobile_screens.js, which keeps asking on its
 * own rarer schedule. One implementation, so the two can never disagree about
 * what a state key is.
 *
 * WHAT IT IS FOR, which is not what it looks like. Neither problem it reports
 * breaks anything today — assigning to an undeclared key simply creates it.
 * What it protects against is the COLLISION: `state.pos` was the operator's
 * ROLE (loadMe writes it; the money gate reads it) and a later edit reused it
 * for the purchase-order list. Nothing threw. The two took turns clobbering
 * each other, and the symptom would have been revenue appearing for a warehouse
 * operator, which no render test looks for. A key nobody can see in the literal
 * is a name the next author is free to take.
 */
'use strict';

/* THE STRIPPER IS THE ORPHAN PASS'S, NOT THE SIMPLER ONE THIS CHECK USED.
   The naive block-comment pattern treats the slash-star inside `image/*` — and
   inside any https URL ending the same way — as a comment OPENING, and then
   eats everything up to the next comment CLOSE, which in this file is whatever
   real comment comes next, eight lines away. For the orphan pass that showed up
   as a wired handler reported unreachable: loud, wrong, and months of red. Here
   it would have been SILENT and the wrong way round — source eaten is `state.x`
   uses not counted, which can only ever HIDE an undeclared key, never invent
   one. The guard is one character wide: a real block comment never opens
   immediately after a word character. It is the same shape as the `[^:]` below,
   which is there so `https://` is not read as a line comment.

   This very comment was written with a literal comment-close inside it, quoted,
   and closed itself eleven lines early. Node said so at once, which is the
   difference between a source file and a regex over one. */
const strip = (t) => t
  .replace(/(^|[^\w])\/\*[\s\S]*?\*\//g, '$1 ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/**
 * Top-level keys of the state literal, each mapped to how many times it is
 * declared. A regex cannot do this: the literal packs many keys on one line AND
 * contains nested objects (`sw:{fapiao:…, affiliate:…}` is a map of feature
 * flags, not of state keys). So walk it, tracking brace depth and skipping
 * quoted strings.
 */
function declaredKeys(literal) {
  const seen = new Map();
  let depth = 0, q = null, ident = '';
  for (let i = 0; i < literal.length; i++) {
    const c = literal[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; ident = ''; continue; }
    if (c === '{' || c === '[' || c === '(') { depth++; ident = ''; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; ident = ''; continue; }
    if (/[A-Za-z0-9_$]/.test(c)) { ident += c; continue; }
    if (c === ':' && depth === 0 && ident) seen.set(ident, (seen.get(ident) || 0) + 1);
    ident = '';
  }
  return seen;
}

/** The literal's own bounds, so no caller has to guess a byte window. */
const LITERAL_RE = /\bconst state\s*=\s*\{([\s\S]*?)\n\};/;

/**
 * @param {string} src  the whole of public/m.html
 * @returns {{error: string|null, dupes: string[], undeclared: string[],
 *            declaredCount: number, usedCount: number}}
 *
 * `error` is for the cases where the check could not RUN — no script block, no
 * state literal. Reported rather than thrown, and separately from a finding,
 * because "I looked and found nothing wrong" and "I could not look" must never
 * arrive at a caller wearing the same face. That is how a check goes quietly
 * green over a file it stopped being able to parse.
 */
function stateKeyProblems(src) {
  const raw = (String(src).match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
  if (!raw) {
    return { error: 'cannot find the app\'s <script> block', dupes: [], undeclared: [], declaredCount: 0, usedCount: 0 };
  }
  const js = strip(raw);
  const literal = (js.match(LITERAL_RE) || [])[1] || '';
  if (!literal) {
    return { error: 'cannot find the state literal', dupes: [], undeclared: [], declaredCount: 0, usedCount: 0 };
  }
  const seen = declaredKeys(literal);
  const used = new Set([...js.matchAll(/\bstate\.([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]));
  return {
    error: null,
    dupes: [...seen].filter(([, n]) => n > 1).map(([k]) => k).sort(),
    undeclared: [...used].filter((k) => !seen.has(k)).sort(),
    declaredCount: seen.size,
    usedCount: used.size,
  };
}

/** The literal's text, for callers that need to assert a key is declared a
 *  particular WAY (test_mobile_ask_strip.js wants `askOpen:null`, not merely
 *  `askOpen:`). Given here so nobody re-guesses where the literal ends. */
function stateLiteral(src) {
  const raw = (String(src).match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
  return (raw.match(LITERAL_RE) || [])[1] || '';
}

module.exports = { stateKeyProblems, stateLiteral, declaredKeys, strip };
