/**
 * The phone app's (public/m.html) static guards — every check that reads the
 * file and needs no browser — in one place, with two callers.
 *
 * WHY A MODULE. These checks lived as inline blocks in
 * scripts/test_mobile_screens.js, which drives Chromium and is therefore in the
 * slow shard, which this repo does not run (CLAUDE.md, "Tests"). They are the
 * checks that catch real phone breakage — a helper called but deleted, a
 * command nothing can reach, a DB key a slice took with it — and lanes were
 * copying them by hand into their own suites. The state-key check went the same
 * way first (scripts/lib/m-state-keys.js) and its header tells that story.
 *
 * So the logic is here, and:
 *   • scripts/test_mobile_static_guards.js (fast shard) runs every one of them
 *     against the real m.html on every gate;
 *   • scripts/test_mobile_screens.js (slow shard) still runs them too, through
 *     this module, before its renders — it lost no check.
 * One implementation, so the two can never disagree about what they find.
 *
 * Each function takes the page source and returns what it found (an array of
 * problems, empty when clean). Wording and logic are the slow suite's, moved
 * here unchanged; its comments over each call site still say why each exists.
 */
'use strict';

/* The app's own script: the first bare <script>. The inlined td-datetime block
   (scripts/lib/m-probe.js) carries an attribute so it never matches. */
function appScript(src) {
  return (src.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
}
// The simple stripper the older passes use.
function stripSimple(t) {
  return t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
// The guarded stripper: a block comment never opens right after a word
// character, so `image/*` and `https://…/*` survive (see the orphan pass).
function stripGuarded(t) {
  return t.replace(/(^|[^\w])\/\*[\s\S]*?\*\//g, '$1 ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/* Every mapX / loadX / screenX / sheetX that is referenced must be defined. */
/* THE GUARDED STRIPPER, NOT THE SIMPLE ONE (§325 T2). With the simple one this
   pass reported screenAboutEdit() "called but never defined" on main: the
   About editor's file input sets `el.accept='image/*'`, the simple stripper
   read that slash-star as a comment opening and ate everything up to the next
   comment close — the function's own definition with it. The orphan pass below
   hit the same trap and fixed it the same way; this pass had kept the old
   stripper. Fixtures in scripts/test_mobile_static_guards.js prove the pass
   still finds a helper that really is missing. */
function missingHelpers(src) {
  const js = stripGuarded(appScript(src));
  const defined = new Set();
  for (const m of js.matchAll(/(?:function|const|let|var)\s+([a-zA-Z_$][\w$]*)/g)) defined.add(m[1]);
  const called = new Set();
  for (const m of js.matchAll(/\b((?:map|load|screen|sheet)[A-Z][\w$]*)\b/g)) called.add(m[1]);
  return [...called].filter((n) => !defined.has(n)).sort();
}

/* T(en, zh) pairs whose Chinese half is English. */
function englishOnlyPairs(src) {
  const js = stripSimple(appScript(src));
  const cjk = (t) => /[一-鿿]/.test(t);
  const bad = [];
  for (const m of js.matchAll(/(^|[^\w$.])T\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*'((?:[^'\\]|\\.)*)'\s*\)/g)) {
    const [, , en, zh] = m;
    if (!cjk(zh) && /[A-Za-z]{3}/.test(zh) && zh === en) bad.push(en);
    else if (!cjk(zh) && /[A-Za-z]{4,}\s+[A-Za-z]{3,}/.test(zh)) bad.push(en);
  }
  return [...new Set(bad)];
}

/* Commands called with extra arguments while the dispatcher is not variadic. */
function droppedArguments(src) {
  const js = stripSimple(appScript(src));
  const disp = (js.match(/window\.APP\s*=\s*\{\s*cmd\s*:\s*\(([^)]*)\)/) || [])[1] || '';
  if (/\.\.\./.test(disp)) return [];
  const multi = new Set();
  for (const m of js.matchAll(/APP\.cmd\(\s*'([a-zA-Z_$][\w$]*)'\s*,[^)]*,[^)]*\)/g)) multi.add(m[1]);
  return [...multi].sort();
}

/* References to the 'noop' command (a control wired to nothing). */
function noopReferences(src) {
  const t = stripSimple(src);
  return [...t.matchAll(/APP\.cmd\(\s*'noop'/g)].length + [...t.matchAll(/\breg\(\s*'noop'/g)].length;
}

/* The guarded stripper checked against its own trap. Names of failed fixtures. */
function stripperProblems() {
  // A stripper that eats too much does not fail loudly — it reports a wired
  // handler as unreachable, which reads as a real finding. The second fixture is
  // the shape that regressed, and its trailing comment is load-bearing: the old
  // stripper needed a later `*/` to run TO.
  const cases = [
    ['a block comment is removed', `a=1; /* reg('ghost') */ b=2;`, (o) => !o.includes('ghost')],
    ['a MIME wildcard is not a comment',
      `<input accept="image/*" onchange="APP.cmd('kept',this)">\n/* a later comment */`,
      (o) => o.includes("'kept'")],
    ['a line comment is removed', `a=1; // reg('ghost2')\nb=2;`, (o) => !o.includes('ghost2')],
    ['a url is not a line comment', `u="https://x.example/p"; APP.cmd('kept2')`, (o) => o.includes("'kept2'")],
  ];
  return cases.filter(([, s, ok]) => !ok(stripGuarded(s))).map(([name]) => name);
}

/* reg('<name>') whose name appears nowhere else (no way in). */
function unreachableCommands(src) {
  const js = stripGuarded(appScript(src));
  const names = [...new Set([...js.matchAll(/\breg\(\s*'([a-zA-Z_$][\w$]*)'/g)].map((m) => m[1]))];
  return names.filter((n) => {
    const asString = (js.match(new RegExp("'" + n + "'", 'g')) || []).length;
    const asMember = (js.match(new RegExp('\\bCMD\\.' + n + '\\b', 'g')) || []).length;
    return asString + asMember <= 1;
  }).sort();
}

/* Theme tokens: a light-only tint/ink, and a hue used as text on its own tint.
   { error } when the theme blocks cannot be found. */
/* THE STYLE BLOCK THAT HOLDS THE THEME, NOT THE FIRST ONE (§325 T2). The pass
   read the first <style> in the file, and a later edit put the @font-face block
   first, so on main it answered "cannot find the theme blocks" and checked
   nothing. It now reads the <style> block that declares both :root and the dark
   theme — the one it always meant. */
function themeProblems(src) {
  const styles = [...src.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  const css = styles.find((c) => /:root\s*\{/.test(c) && /:root\[data-theme="dark"\]\s*\{/.test(c)) || styles[0] || '';
  const block = (re) => (css.match(re) || [])[1] || '';
  const light = block(/:root\s*\{([\s\S]*?)\}/);
  const dark = block(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/);
  if (!light || !dark) return { error: 'cannot find the theme blocks', lightOnly: [], textOnTint: [] };
  // name -> value, so an ALIAS can be skipped: --accent-tint is
  // `var(--dusk-tint)`, which follows whatever the theme sets. And the hyphen
  // before the suffix keeps --ink itself out of it: that is a raw palette hue,
  // fixed on purpose.
  const decls = (b) => new Map([...b.matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const inDark = decls(dark);
  const lightOnly = [...decls(light)]
    .filter(([n, v]) => /-[a-z]+-(tint|ink)$/.test(n) && !/^var\(/.test(v) && !inDark.has(n))
    .map(([n]) => n).sort();
  const textOnTint = [...new Set([...src.matchAll(/background:var\(--([a-z]+)-tint[^)]*\);\s*color:var\(--\1[,)]/g)].map((m) => m[1]))];
  return { error: null, lightOnly, textOnTint };
}

/* DB.x read but absent from the DB literal. { error } when no literal. */
function dbKeyGaps(src) {
  const js = stripSimple(appScript(src));
  const lit = (js.match(/\bconst DB\s*=\s*\{([\s\S]*?)\n\};/) || [])[1] || '';
  if (!lit) return { error: 'cannot find the DB literal', gone: [] };
  const have = new Set([...lit.matchAll(/\n {2}([a-zA-Z_$][\w$]*)\s*:/g)].map((m) => m[1]));
  const read = new Set([...js.matchAll(/\bDB\.([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]));
  return { error: null, gone: [...read].filter((k) => !have.has(k)).sort() };
}

module.exports = {
  appScript, stripSimple, stripGuarded,
  missingHelpers, englishOnlyPairs, droppedArguments, noopReferences,
  stripperProblems, unreachableCommands, themeProblems, dbKeyGaps,
};
