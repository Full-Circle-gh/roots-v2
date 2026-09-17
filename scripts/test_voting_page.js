#!/usr/bin/env node
/**
 * test_voting_page.js — the rebuilt admin Voting page (§154).
 *
 *   node scripts/test_voting_page.js
 *
 * WHY THIS SUITE EXISTS. The page it covers was rebuilt from scratch because
 * the old one had drifted off every rule it was supposed to follow at once:
 * uppercase pills, a purpose paragraph under the title, an open poll painted
 * in an error red, a black-on-lime featured chip, and an editor that injected
 * itself above the list it was editing. None of that was caught by anything —
 * the rules lived in documents and the page lived in a browser.
 *
 * So the checks here are the rules, not the pixels. Each one names the rule it
 * holds, and each one only goes down.
 *
 * The arithmetic half is driven in a sandbox against hand-built polls, because
 * "who is leading" and "what will the customer see" are the parts that look
 * obviously right and are easy to get subtly wrong — a poll with no votes has
 * no leader, and a display floor BELOW real turnout must not shrink it.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };
const is  = (a, e, m) => (a === e ? ok(m) : bad(m, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`));
const yes = (c, m, extra) => (c ? ok(m) : bad(m, extra));
const no  = (c, m, extra) => (!c ? ok(m) : bad(m, extra));
const section = (t) => console.log('\n' + t);

const HTML = fs.readFileSync(path.join(ROOT, 'public/retail-admin.html'), 'utf8');
const JS   = fs.readFileSync(path.join(ROOT, 'public/retail-admin/10-extras.js'), 'utf8');

const SEC = (() => {
  const i = HTML.indexOf('<section id="tab-voting">');
  const j = HTML.indexOf('</section>', i);
  if (i < 0 || j < 0) throw new Error('the Voting section is not in retail-admin.html');
  return HTML.slice(i, j);
})();

const MOD = (() => {
  const i = JS.indexOf('// VOTING — community polls.');
  const j = JS.indexOf('// ─── About page editor');
  if (i < 0 || j < 0) throw new Error('the Voting module is not in 10-extras.js');
  return JS.slice(i, j);
})();

// ── §1 · the standard page header, and one Dusk element ───────────────────
section('1 · the page header (patterns §1.7, §1.8)');

yes(SEC.includes('<h2>Voting · 投票</h2>'), 'the page states its own name in the shared .td-head');
yes(/id="vot-status"[^>]*hidden/.test(SEC),
    'the status line starts absent — it appears only when there is work waiting',
    'a status line that ships a placeholder is the Sales failure §1.7 was written against');
no(/Build polls the mini-app shows/.test(SEC), 'the purpose paragraph is gone (§1.7)');

is((SEC.match(/vot-dusk/g) || []).length - (SEC.match(/\.vot-dusk/g) || []).length, 1,
   'exactly one element in the shelf markup is painted Dusk');
const edDusk = (MOD.match(/btn-primary vot-dusk/g) || []).length;
yes(edDusk >= 1 && MOD.indexOf('btn-primary vot-dusk') > MOD.indexOf('function votRenderEditor'),
    'the editor\'s Dusk lives inside the editor, which only renders once the shelf is hidden');

// ── §2 · the dead brand, and the colours that were never in the system ────
section('2 · nothing of the old page survives (§1.6, §1.10)');

is((SEC.match(/text-transform: *uppercase/g) || []).length, 0, 'no uppercase anywhere in the section');
for (const [hex, what] of [['#E96174', 'the error-red open pill'],
                           ['#CCD900', 'the lime featured chip'],
                           ['#1a1a17', 'the black featured chip']]) {
  no(SEC.includes(hex), `${what} (${hex}) is gone`);
}
no(SEC.includes('.vot-stat'), 'the old status-pill class is gone, not merely unused');
no(/#tab-voting[^{]*\{[^}]*box-shadow:[^}]*,[^}]*\}/.test(SEC), 'no stacked shadows (design system §3)');

// ── §3 · colour encodes state, and only state ─────────────────────────────
section('3 · colour is state, never decoration (§1.10)');

const rule = (sel) => {
  const at = SEC.indexOf(sel);
  return at < 0 ? '' : SEC.slice(at, SEC.indexOf('}', at));
};
yes(rule('.vot-badge.is-open').includes('--td-sage-tint'), 'open is sage — the all-clear colour');
yes(rule('.vot-badge.is-draft').includes('--td-raised'), 'draft is neutral');
yes(rule('.vot-badge.is-closed').includes('--td-raised'), 'closed is neutral — finished is not an alarm');
const feat = rule('.vot-badge.is-featured');
yes(feat.includes('--td-raised') && !/sage|amber|brick|dusk/.test(feat),
    'featured takes no status colour at all — it is a property, not a state');
yes(rule('.vot-bar.is-lead .vot-fill').includes('--td-text'),
    'the leading bar is Ink — the operator\'s emphasis, not a status (§1.8)');
no(/--td-dusk/.test(rule('.vot-badge')), 'no Dusk on a badge — nothing here is the AI acting');

// ── §4 · one language on screen ───────────────────────────────────────────
section('4 · one language at a time (§1.11)');

const pairs = [...MOD.matchAll(/votT\(\s*(['"`])([\s\S]*?)\1\s*,\s*(['"`])([\s\S]*?)\3\s*\)/g)];
yes(pairs.length > 50, `${pairs.length} label pairs go through votT()`);
const cjk = /[一-鿿]/;
const wrongSide = pairs.filter(([, , en]) => cjk.test(en));
is(wrongSide.length, 0, 'no pair carries Chinese in its English half',
   wrongSide.slice(0, 3).map(p => p[2]).join(' | '));
const missingCn = pairs.filter(p => !cjk.test(p[4]) && !/^[\s\d§N%×·]*$/.test(p[4]));
is(missingCn.length, 0, 'no pair ships an English string in its Chinese half',
   missingCn.slice(0, 3).map(p => p[4]).join(' | '));

yes(MOD.includes('function votSafe') && MOD.includes('data-no-i18n'),
    'merchant-authored text is shielded from the language walker');
for (const field of ['question_en', 'label_en']) {
  const uses = [...MOD.matchAll(new RegExp(`[^\\n]*\\b${field}\\b[^\\n]*`, 'g'))].map(m => m[0])
    .filter(l => l.includes('${') || l.includes('votSafe'));
  const unshielded = uses.filter(l => l.includes('${') && !l.includes('votSafe') && !l.includes('escapeAttr') && !l.includes('escapeHtml'));
  is(unshielded.length, 0, `every rendered ${field} is shielded or escaped`,
     unshielded.slice(0, 2).join('\n      '));
}

// ── §5 · every control that writes, disables while it writes ──────────────
section('5 · in-flight states, and the button captured before the await (§1.12)');

const writers = [...MOD.matchAll(/async function (vot\w+)\(([^)]*)\)\s*\{([\s\S]*?)\n\}/g)]
  .filter(m => m[3].includes('adminWrite'));
yes(writers.length >= 4, `${writers.length} write paths found`);
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
for (const [, name, , raw] of writers) {
  // A comment that says the word does not run it — strip them, or this check
  // reads its own explanation as the first await and fails a correct handler.
  const body = stripComments(raw);
  const capture = body.indexOf('ev && ev.currentTarget');
  const firstAwait = body.indexOf('await');
  yes(capture > -1 && capture < firstAwait,
      `${name}() captures its button synchronously, before any await`,
      'event.currentTarget is null once dispatch ends — the disable silently no-ops');
}
const calls = (MOD.match(/adminWrite\(\{/g) || []).length;
const withBtn = (MOD.match(/adminWrite\(\{\s*\n?\s*btn,/g) || []).length;
is(withBtn, calls, 'every adminWrite call is handed the button it must disable');

// ── §6 · the editor is a takeover, not a sheet ────────────────────────────
section('6 · authoring is a full page (§1.13, §1.7a)');

yes(/#tab-voting\.vot-editing > \.vot-wrap \{ display: none; \}/.test(SEC),
    'the shelf is display:none while the editor is up — gone, not merely covered');
yes(MOD.includes("history.pushState({ votEditor: true }") && MOD.includes("popstate"),
    'the browser Back gesture returns to the shelf rather than leaving the admin');
yes(/mount\.innerHTML = ''/.test(MOD),
    'closing the editor empties it, so none of it stays in the tab order');
yes(MOD.includes('_edDirty') && MOD.includes('Leave without saving'),
    'leaving with unsaved changes asks once');

// ── §7 · the page opens on the polls, not on its settings ─────────────────
section('7 · the live poll owns the page');

yes(SEC.indexOf('id="vot-stage"') < SEC.indexOf('class="vot-set"'),
    'the stage comes before the settings card in the document');
yes(SEC.indexOf('id="vot-stage"') < SEC.indexOf('id="vot-rest"'),
    'the open poll comes before the rest of the shelf');
yes(/id="vot-set-body"[^>]*hidden/.test(SEC), 'the settings start folded away');

// ── §8 · the arithmetic, in a sandbox ─────────────────────────────────────
section('8 · who is leading, and what the customer will see');

const ctx = vm.createContext({
  votT: (en) => en,
  $: (sel) => ({ _sel: sel, textContent: '' }),
  console,
});
const grab = (name) => {
  const at = MOD.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`${name} not found`);
  // Balance braces from the function's opening brace.
  let i = MOD.indexOf('{', at), depth = 0, end = i;
  for (; i < MOD.length; i++) {
    if (MOD[i] === '{') depth++;
    else if (MOD[i] === '}') { depth--; if (!depth) { end = i; break; } }
  }
  return MOD.slice(at, end + 1);
};
vm.runInContext('var _polls = []; var _ed = null; var _out = { textContent: "" };', ctx);
vm.runInContext(grab('votTally'), ctx);
vm.runInContext(grab('votStagePoll'), ctx);
vm.runInContext(grab('votBoostLine').replace("$('#vot-ed-boost')", '_out'), ctx);

const poll = (o) => Object.assign({ id: 1, status: 'open', is_featured: 0, options: [] }, o);
const opt = (id, votes) => ({ id, label_en: 'opt' + id, votes });

const t1 = vm.runInContext('votTally(' + JSON.stringify(
  poll({ options: [opt(1, 10), opt(2, 40), opt(3, 36)] })) + ')', ctx);
is(t1.total, 86, 'the total is summed from the options, not read from the cached column');
is(t1.leadId, 2, 'the most-voted option leads');

const t2 = vm.runInContext('votTally(' + JSON.stringify(
  poll({ status: 'closed', winner_option_id: 3, options: [opt(1, 10), opt(2, 40), opt(3, 36)] })) + ')', ctx);
is(t2.leadId, 3, 'a closed poll\'s named winner beats the raw count');

const t3 = vm.runInContext('votTally(' + JSON.stringify(
  poll({ options: [opt(1, 0), opt(2, 0)] })) + ')', ctx);
is(t3.leadId, null, 'a poll with no votes has no leader — nobody is winning nothing');

const t4 = vm.runInContext('votTally(' + JSON.stringify(
  poll({ winner_option_id: 99, options: [opt(1, 5), opt(2, 1)] })) + ')', ctx);
is(t4.leadId, 1, 'a winner id that is not one of this poll\'s options is ignored');

// The stage picks the poll the operator came to see.
const setPolls = (arr) => vm.runInContext('_polls = ' + JSON.stringify(arr) + ';', ctx);
setPolls([poll({ id: 1, status: 'draft' }), poll({ id: 2, status: 'open' }), poll({ id: 3, status: 'open', is_featured: 1 })]);
is(vm.runInContext('votStagePoll().id', ctx), 3, 'the featured open poll takes the stage');
setPolls([poll({ id: 1, status: 'draft' }), poll({ id: 2, status: 'closed' })]);
is(vm.runInContext('votStagePoll()', ctx), null, 'nothing open → no stage poll, and never a draft');

// The display floor mirrors the server's applyPollDisplayBoost exactly.
const boost = (options, floor) => {
  vm.runInContext('_ed = ' + JSON.stringify({ display_min_total: floor, options }) + '; _out.textContent = ""; votBoostLine();', ctx);
  return vm.runInContext('_out.textContent', ctx);
};
yes(/^Off\./.test(boost([opt(1, 40), opt(2, 46)], 0)), 'no floor → the line says it is off');
yes(/^Off\./.test(boost([opt(1, 40), opt(2, 46)], 50)),
    'a floor BELOW real turnout is off — genuine votes are never shrunk');
const scaled = boost([opt(1, 40), opt(2, 46)], 860);
const serverShown = [40, 46].reduce((s, v) => s + Math.round(v * (860 / 86)), 0);
yes(scaled.includes(String(serverShown)),
    `the preview says exactly what the server will render (${serverShown})`, scaled);
yes(boost([opt(1, 0), opt(2, 0)], 500).includes('first real vote'),
    'a floor with no real votes inflates nothing — there is no ratio to keep');

// ── §9 · the templates actually run ───────────────────────────────────────
section('9 · every region renders, against real-shaped polls');

/* Static checks cannot tell a template that runs from one that throws on its
   first real poll, and this repo does not run browser suites. So the render
   functions are pulled into a sandbox with a DOM stub thin enough to be
   honest — a mount is an object with an innerHTML — and driven against
   fixtures shaped like the endpoint's own rows. What this proves is narrow
   and worth having: no ReferenceError, no undefined in the output, and the
   words the page promises are in the markup it produces. */
const dom = {};
const mount = (id) => (dom[id] = dom[id] || { innerHTML: '', textContent: '', hidden: false });
const ctx2 = vm.createContext({
  votT: (en) => en,
  // In the browser a global IS window.x — the sandbox has to offer both or
  // it fails code that is correct on the page.
  window: { cuLang: () => 'en' },
  cuLang: () => 'en',
  $: (sel) => mount(sel),
  tdWhen: (iso) => 'Mar 12, 2:00 PM',
  escapeHtml: (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  escapeAttr: (x) => String(x == null ? '' : x),
  setTimeout: (fn) => fn(),
  clearTimeout: () => {},
  console,
});
vm.runInContext('var _polls = [], _ed = null, _edLang = "en", _prevTimer = null, _edDirty = false;'
  + ' var _votCfg = { intro_en: "Vote — earn {pts} points", intro_cn: "", show_counts: false };'
  + ' var POLL_PALETTE = ["#F2CA6C", "#F4B8CB"];', ctx2);
for (const fn of ['votSafe', 'votPick', 'votStatusWord', 'votLetter', 'votTally', 'votStagePoll', 'votCloses',
                  'votRenderStatusLine', 'votRenderStage', 'votRenderRest', 'votBoostLine',
                  'votRenderPreview', 'votRenderEditor']) {
  vm.runInContext(grab(fn), ctx2);
}

const FIXTURE = [
  { id: 7, status: 'open', is_featured: 1, question_en: 'Which hummus should we make next?',
    reward_points: 1, closes_at: null, display_min_total: 0, winner_option_id: null,
    options: [{ id: 1, label_en: 'Roasted Red Pepper', votes: 40, color_hex: '#F2CA6C' },
              { id: 2, label_en: 'Za\'atar', votes: 26, color_hex: '#F4B8CB' },
              { id: 3, label_en: 'Beetroot', votes: 20, color_hex: '#B2CFED' }] },
  { id: 8, status: 'draft', is_featured: 0, question_en: 'Which wrap next?', reward_points: 5,
    display_min_total: 0, options: [{ id: 4, label_en: 'Falafel', votes: 0 }] },
];
vm.runInContext('_polls = ' + JSON.stringify(FIXTURE) + ';', ctx2);

let threw = null;
try { vm.runInContext('votRenderStatusLine(); votRenderStage(); votRenderRest();', ctx2); }
catch (e) { threw = e; }
yes(!threw, 'the shelf renders without throwing', threw && threw.stack);

const got = (id) => (dom[id] || { innerHTML: '', textContent: '', hidden: null }).innerHTML;
const stage = got('#vot-stage');
yes(stage.includes('Roasted Red Pepper'), 'the stage names the options');
yes(stage.includes('86 votes'), 'the stage sums the real turnout (40 + 26 + 20)');
yes(stage.includes('47%'), 'the leader\'s share is computed, not guessed');
yes(stage.includes('counts hidden from customers'),
    'with counts off, the stage says so — the operator should not learn it from the mini app');
yes((stage.match(/is-lead/g) || []).length === 1, 'exactly one bar is marked as leading');
no(/undefined|NaN|\[object/.test(stage), 'nothing leaked into the stage markup', stage.slice(0, 200));

is((dom['#vot-status'] || {}).hidden, false, 'one draft → the status line appears');
yes(/1 draft waiting/.test((dom['#vot-status'] || {}).textContent || ''), 'and it counts the drafts, not the polls');

const rest = got('#vot-rest');
yes(rest.includes('Which wrap next?'), 'the draft is on the shelf below');
no(rest.includes('Which hummus'), 'the staged poll is not repeated in the list under it');
no(/undefined|NaN/.test(rest), 'nothing leaked into the shelf markup');

// Nothing open: the empty state is a sentence, not a blank card.
vm.runInContext('_polls = ' + JSON.stringify([FIXTURE[1]]) + '; votRenderStage();', ctx2);
yes(got('#vot-stage').includes('No poll is open'), 'nothing open → the stage says so');
no(/sorry|oops|nothing here yet/i.test(got('#vot-stage')), 'the empty state does not apologise');

// The editor, including its phone preview.
threw = null;
try {
  vm.runInContext('_ed = ' + JSON.stringify(FIXTURE[0]) + '; votRenderEditor();', ctx2);
} catch (e) { threw = e; }
yes(!threw, 'the editor renders without throwing', threw && threw.stack);
const ed = got('#vot-editor');
yes(ed.includes('Publish') || ed.includes('Save changes'), 'the editor offers its commit');
yes(ed.includes('中文') && ed.includes('English'), 'the language picker offers both — it is the one control that may');
const phone = got('#vot-ed-phone');
yes(phone.includes('Your say'), 'the phone preview wears the customer\'s headline');
yes(phone.includes('earn 1 points') && !phone.includes('{pts}'),
    'the tagline\'s {pts} is filled from this poll\'s reward, not shown raw');
no(/undefined|NaN/.test(phone), 'nothing leaked into the preview', phone.slice(0, 200));

// The labels a merchant wrote follow the language the operator picked.
vm.runInContext('cuLang = () => "cn"; window.cuLang = cuLang;', ctx2);
is(vm.runInContext('votPick("Beetroot", "甜菜根")', ctx2), '甜菜根',
   'an operator reading Chinese sees the Chinese option label');
is(vm.runInContext('votPick("Beetroot", "")', ctx2), 'Beetroot',
   'and falls back to the other half when the merchant filled only one');
vm.runInContext('cuLang = () => "en"; window.cuLang = cuLang;', ctx2);

// ── §10 · a bilingual pair is one text node ───────────────────────────────
section('10 · no region renders both languages at once (§1.11, decisions §155)');

/* THE BUG THIS EXISTS FOR, seen in production 2026-09-17. The walker splits a
   text node on " · " when the left half is Chinese-free and the right half is
   not. Put a tag inside the pair — <code>{pts}</code> in the middle of a hint —
   and the pair is no longer one text node: the walker swaps the part it can
   reach and the Chinese AFTER the tag renders in both languages, on a screen
   the operator set to English. Nothing errors. So the rule is mechanical, and
   so is the check: every run of Chinese in this section is either inside a
   proper pair, or inside a block marked as the Chinese half. */
const stripped = SEC.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<!--[\s\S]*?-->/g, '');
const langBlocks = { en: 0, cn: 0 };
for (const m of stripped.matchAll(/data-lang-block="(en|cn)"/g)) langBlocks[m[1]]++;
// A declared Chinese block is allowed to be Chinese throughout, tags and all,
// so take its whole contents out before looking for leaks. Removing the block
// rather than testing each text node's parent is what makes this right for the
// markup INSIDE it — which is the case that produced the bug.
const scan = stripped.replace(/<span[^>]*data-lang-block="cn"[^>]*>[\s\S]*?<\/span>/g, '');
const leaks = [];
for (const m of scan.matchAll(/>([^<]+)</g)) {
  const text = m[1];
  if (!cjk.test(text)) continue;
  if (text.trim() === '中文') continue;                     // the language picker itself
  const [left] = text.split(' · ');
  if (text.includes(' · ') && !cjk.test(left)) continue;   // a proper pair
  leaks.push(text.trim().slice(0, 60));
}
is(leaks.length, 0, 'every Chinese run is either half of a pair or a declared language block',
   leaks.join(' | '));

is(langBlocks.en, langBlocks.cn, 'language blocks come in pairs — one English, one Chinese');
yes(!/data-lang-block="[^"]*"[^>]*>[^<]* · [^<]*</.test(stripped),
    'a declared language block does not also carry a glued pair inside it');

// ── done ──────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
