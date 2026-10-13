#!/usr/bin/env node
/* GATE — a bilingual pair must be ONE text node.
 *
 *   node scripts/check-glued-language.js            pass/fail against the budget
 *   node scripts/check-glued-language.js --list     every finding, with its file
 *
 * WHAT IT CATCHES, and why a grep cannot.
 *
 * `tacet-desktop-patterns.md` §1.11: the admin renders ONE language at a time.
 * The mechanism is a DOM walker (`10-extras.js`, `processNode`) that visits
 * TEXT NODES, and rewrites a node containing " · " (space-middot-space) when its
 * left half is Chinese-free and its right half is not.
 *
 * Put a tag inside such a pair and it stops being one text node:
 *
 *     <span>Write <code>{pts}</code> here. · 在此写 <code>{pts}</code> 它会自动填入。</span>
 *                 ╰── node 2 ──╯          ╰── node 3, holds the " · " ──╯   ╰─ node 5 ─╯
 *
 * Node 3 splits correctly, so the English half looks right and the swap appears
 * to work. Node 5 contains no " · " of its own, so the walker never touches it
 * and it renders in BOTH languages, permanently, on a screen the operator set
 * to English. Nothing throws, nothing logs, and the Chinese reader sees a
 * perfect screen — so it survives review by the only people who can read it.
 *
 * Found in production 2026-09-17 on the rebuilt Voting page. Recorded as
 * `docs/tacet-consolidation-decisions.md` §155, with the fix: copy that needs
 * markup is not a pair at all — it is two blocks, one per language, marked
 * `data-lang-block="en"` / `data-lang-block="cn"`, which the engine already
 * hides by language.
 *
 * TWO SHAPES, TWO RATCHETS. The structural one — Chinese stranded after a tag
 * inside a pair — is unambiguous and its budget is 0. The looser one — Chinese
 * in a node that is neither a pair nor shielded — carries a standing backlog
 * that a person has to work through string by string, so it is counted at its
 * current size and fails only if it GROWS. See the budgets below.
 *
 * SCOPE: the three surfaces that actually run the walker — the admin page, the
 * modules that inject markup into it, and the product editor, which carries its
 * own copy of the same engine. A page without the walker cannot have this bug.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

/* Two budgets, both ratchets. Only ever go down; raising either means a leak
   shipped. They are separate because they are different claims:

   BROKEN — a pair the walker WILL split, with Chinese stranded after a tag.
   Structural, unambiguous, and swept to zero on 2026-09-17. Any new one is a
   bug, so the budget is 0 and stays 0.

   ORPHAN — Chinese in a node that is not a pair and is not shielded, so it
   renders whatever language the operator chose. Most of the standing 161 are
   real (a Chinese-only hint on the Reviews page, a label pair glued with no
   separator at all), and a few are correct by §1.11's scope note: a preview of
   a WeCom card or a quoted WeChat menu path carries Chinese because the reader
   of THAT surface cannot choose a language. Telling those apart needs a person
   per string and, where the string is genuinely missing its English half, a new
   string written. So the backlog is counted rather than failed — but it cannot
   GROW, which is the half that matters for new work.

   234 → 161 on 2026-09-28, and nothing was fixed to get there: the scan was.
   Its backtick-counting read of the .js modules had drifted out of step, so 73
   of the 234 were lines of CODE read as page text, while real page text in the
   same stretches went unread. A new panel landing in one of those stretches
   "added" three orphans that were its own JavaScript. Literals are now found by
   acorn (parsedTemplateLiterals); 161 is the backlog as it really stands, and
   the ratchet starts again from there.
   161 → 159 on 2026-10-13: the Top-up packages table lost its two Chinese-only
   title headers (标题(英文) / 标题(中文)) with the columns they named.
   159 → 135 the same day: Settings' mixed help paragraphs became
   data-lang-block pairs (the splitter skips those by design). */
const BUDGET = 0;
const ORPHAN_BUDGET = 135;

const CJK = /[一-鿿]/;
const VOID = new Set(['br', 'img', 'input', 'hr', 'meta', 'link', 'source',
                      'track', 'area', 'base', 'col', 'embed', 'param', 'wbr']);

const FILES = [
  'public/retail-admin.html',
  'public/product-editor.html',
  ...fs.readdirSync(path.join(REPO, 'public/retail-admin'))
       .filter(f => f.endsWith('.js'))
       .map(f => path.join('public/retail-admin', f)),
];

/* Is this text node a pair the walker will split? Same two gates as the engine:
   it needs " · ", a Chinese-free left half, and Chinese on the right. */
function isPair(text) {
  const at = text.indexOf(' · ');
  if (at < 0) return false;
  return !CJK.test(text.slice(0, at)) && CJK.test(text.slice(at + 3));
}

/* Walk one chunk of markup, tracking the open element stack so a shield on an
   ANCESTOR counts — the case that made the first version of this check wrong. */
function scanChunk(html, file, line, out) {
  html = html.replace(/<style[\s\S]*?<\/style>/gi, '')
             .replace(/<script[\s\S]*?<\/script>/gi, '')
             .replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  const re = /<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const [, closeTag, openTag, attrs, selfClose, text] = m;
    if (closeTag) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === closeTag.toLowerCase()) { stack.length = i; break; }
      }
      continue;
    }
    if (openTag) {
      const tag = openTag.toLowerCase();
      if (VOID.has(tag) || selfClose) continue;
      stack.push({ tag, attrs: attrs || '', pairSeen: false });
      continue;
    }
    if (!text || !CJK.test(text)) continue;
    const top = stack[stack.length - 1];
    if (isPair(text)) { if (top) top.pairSeen = true; continue; }
    const shielded = stack.some(e => /data-no-i18n|data-lang-block/.test(e.attrs));
    if (shielded) continue;
    if (text.trim() === '中文' || text.trim() === 'EN · 中文') continue;  // the picker names both on purpose
    const kind = top && top.pairSeen ? 'broken' : 'orphan';
    out.push({ file, line, kind, text: text.trim().slice(0, 78),
               host: top ? `<${top.tag}${top.attrs.slice(0, 48)}>` : '(top level)' });
  }
}

/* A module's markup lives in its template literals. Each is scanned ALONE —
   concatenating them invents elements that never share a parent, which is how
   the first pass produced a page of nonsense. */
function templateLiterals(src) {
  const out = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '`') continue;
    if (i > 0 && src[i - 1] === '\\') continue;
    let j = i + 1, depth = 0;
    for (; j < src.length; j++) {
      if (src[j] === '\\') { j++; continue; }
      if (src[j] === '$' && src[j + 1] === '{') { depth++; j++; continue; }
      if (src[j] === '}' && depth) { depth--; continue; }
      if (src[j] === '`' && !depth) break;
    }
    const body = src.slice(i + 1, j);
    if (body.includes('<')) {
      out.push({ body: body.replace(/\$\{[^}]*\}/g, 'X'),
                 line: src.slice(0, i).split('\n').length });
    }
    i = j;
  }
  return out;
}

/* The same literals, found by a real parser. The scan above pairs backticks
   by counting them, so ONE backtick it misreads — inside a comment, a string
   or a regex — flips every pairing after it: from there it reads code as page
   text and page text as code, hiding real orphans and inventing others. acorn
   (already a dev dependency, for this repo's own lint) knows which backticks
   open a template. Each literal's `${…}` holes become X, exactly as above. The
   counting scan stays as the fallback for a file acorn cannot parse. */
function parsedTemplateLiterals(src) {
  let ast;
  try { ast = require('acorn').parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true }); }
  catch (e) { return null; }
  const out = [];
  (function walk(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'TemplateLiteral') {
      const body = node.quasis.map(q => q.value.raw).join('X');
      if (body.includes('<')) out.push({ body, line: node.loc.start.line });
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v);
    }
  })(ast);
  return out;
}

const findings = [];
for (const rel of FILES) {
  const abs = path.join(REPO, rel);
  if (!fs.existsSync(abs)) continue;
  const src = fs.readFileSync(abs, 'utf8');
  if (rel.endsWith('.js')) {
    for (const lit of parsedTemplateLiterals(src) || templateLiterals(src)) scanChunk(lit.body, rel, lit.line, findings);
  } else {
    scanChunk(src, rel, 0, findings);
  }
}

const broken = findings.filter(f => f.kind === 'broken');
const orphans = findings.filter(f => f.kind === 'orphan');

console.log('GATE — a bilingual pair must be one text node\n');
console.log(`    scanned ${FILES.length} file(s)`);
console.log(`    ${broken.length} pair(s) broken by a tag — these render both languages`);
console.log(`    ${orphans.length} Chinese-only node(s) with no pair — a counted backlog, see the header`);
console.log(`    budgets: ${BUDGET} broken · ${ORPHAN_BUDGET} orphan\n`);

if (process.argv.includes('--list')) {
  for (const f of broken) {
    console.log(`  BROKEN  ${f.file}${f.line ? ':' + f.line : ''}`);
    console.log(`          ${JSON.stringify(f.text)}`);
    console.log(`          in ${f.host}`);
  }
  if (process.argv.includes('--orphans')) {
    for (const f of orphans) console.log(`  orphan  ${f.file}${f.line ? ':' + f.line : ''}  ${JSON.stringify(f.text)}`);
  }
}

console.log('═'.repeat(72));
let failed = false;
if (broken.length > BUDGET) {
  failed = true;
  console.log(`RESULT: FAIL — ${broken.length} broken pair(s), budget ${BUDGET}.`);
  console.log('        A pair is one text node. Copy that needs markup is two blocks,');
  console.log('        one per language, marked data-lang-block. See decisions §155.');
  console.log('        Run with --list to see where they are.');
}
if (orphans.length > ORPHAN_BUDGET) {
  failed = true;
  console.log(`RESULT: FAIL — ${orphans.length} Chinese-only node(s), budget ${ORPHAN_BUDGET}.`);
  console.log('        New copy ships both halves as one text node, or two blocks');
  console.log('        marked data-lang-block. Run with --list --orphans to see them.');
}
if (failed) process.exit(1);
console.log(`RESULT: PASS — ${broken.length} broken pair(s) and ${orphans.length} orphan(s), both at or under budget.`);
