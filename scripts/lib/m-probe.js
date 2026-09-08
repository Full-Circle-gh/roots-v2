/**
 * The shared harness for behavioural probes against public/m.html.
 *
 * scripts/test_mobile_screens.js proves every screen paints. These probes prove
 * a screen paints the RIGHT thing: each case seeds state, renders, and asserts
 * on the innerText of a NAMED element.
 *
 * Two rules learned the hard way, and the reason this is a shared file rather
 * than a copied block:
 *
 *   • Assert on one element's innerText, never document.body.innerHTML. The
 *     body contains the entire <script>, so indexOf() answers "yes" to every
 *     string that appears in a comment, and a list rendered BEHIND an open
 *     sheet answers "yes" to text the user cannot see.
 *   • Run the probe INSIDE the app page. `state` is a const — it is not on
 *     window, so a parent frame cannot reach it.
 *
 * A case is [name, setupJs, [[label, exprJs], …]]. Inside setup and exprs you
 * have the app's own globals plus txt(id) → that element's innerText.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const APP = path.join(__dirname, '..', '..', 'public', 'm.html');
const TD_DATETIME = path.join(__dirname, '..', '..', 'public', 'td-datetime.js');

/**
 * m.html has exactly one LOCAL script dependency — /assets/td-datetime.js,
 * which every date and time in the app renders through. Every harness in this
 * directory writes the page into a temp dir and opens it over file://, where
 * an absolute path resolves against the filesystem ROOT and the fetch 404s.
 * A page that loads without it does not degrade: tdWhen is undefined, the
 * first list that formats a date throws, and the screen paints empty — which
 * reads exactly like the bug a probe is looking for.
 *
 * So it is INLINED, from the same file the server sends. Not stubbed: the
 * suites that assert on a rendered date are asserting on the real §1.18
 * formatter, and a stub would let a format drift past them.
 *
 * The `data-vendor` attribute matters. Several suites lift the app's own
 * source with /<script>([\s\S]*?)<\/script>/ — a BARE tag — and an inlined
 * dependency with no attributes would be the first match, handing them the
 * wrong file to check.
 */
function inlineTdDatetime(src) {
  const js = fs.readFileSync(TD_DATETIME, 'utf8');
  // Function replacement: `$&`/`$1` in the inlined source would otherwise be
  // read as substitution patterns.
  return src.replace(/<script src="\/assets\/td-datetime\.js"><\/script>/,
    () => `<script data-vendor="td-datetime">${js}</script>`);
}

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  try {
    const p = require('playwright').chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (e) { /* not installed here */ }
  const guesses = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  for (const g of guesses) { if (fs.existsSync(g)) return g; }
  const pw = '/opt/pw-browsers';
  if (fs.existsSync(pw)) {
    for (const d of fs.readdirSync(pw)) {
      const p = path.join(pw, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/* opts.settle — milliseconds to let the page breathe between the setup and the
   checks. Default 0, which runs them in the SAME task, and that is deliberate
   for every probe that only paints: it is the fastest and the least flaky.
   But a setup that starts asynchronous work (a fetch, an SDK load, anything
   that resolves in a microtask) cannot be asserted on in the task that started
   it — the continuation has not run yet, so the check sees the state before
   any of it happened and reads as a stone-cold failure. Those probes pass a
   settle. */
function run(label, cases, opts) {
  const settle = (opts && opts.settle) || 0;
  const chrome = findChrome();
  if (!chrome) { console.log('SKIP — no Chromium found. Set CHROME_BIN to run this check.'); process.exit(0); }
  const src = inlineTdDatetime(fs.readFileSync(APP, 'utf8')
    // No network in a test runner: the CDN icon set and the font stylesheet
    // would each hold the page open until they time out.
    .replace(/<script src="https:\/\/unpkg\.com[^>]*><\/script>/, '')
    .replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/, ''));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm-probe-'));
  let asserted = 0; const failures = [];

  for (const [name, setup, checks] of cases) {
    const harness = `<script>addEventListener('load',function(){setTimeout(function(){
      var out=[];
      function txt(id){ var el=document.getElementById(id); return el?el.innerText:''; }
      function sheetText(){ var el=document.querySelector('.sheet'); return el?el.innerText:''; }
      try{ ${setup} }catch(e){ document.title='BAD setup threw: '+e.message; return; }
      var names=${JSON.stringify(checks.map((c) => c[0]))};
      var fns=[${checks.map((c) => `function(){return (${c[1]})}`).join(',')}];
      function finish(){
        for(var i=0;i<fns.length;i++){
          var ok=false, why='';
          try{ ok=!!fns[i](); }catch(e){ why=' ('+e.message+')'; }
          if(!ok) out.push(names[i]+why);
        }
        document.title = out.length ? ('BAD '+out.join(' ¦ ')) : 'GOOD';
      }
      if(${settle}) setTimeout(finish,${settle}); else finish();
    },250)});</script>`;
    const file = path.join(dir, name.replace(/[^a-z0-9]/gi, '_') + '.html');
    fs.writeFileSync(file, src.replace('</body>', harness + '</body>'));
    let out = '';
    try {
      /* maxBuffer IS NOT A TUNING KNOB HERE — IT IS THE BUG THIS LINE CARRIES.
         --dump-dom writes the WHOLE rendered document to stdout, and the
         document is public/m.html plus the harness above plus everything the
         app renders into it. execFileSync's default cap is 1 MiB; m.html alone
         passed 1.01 MB on 2026-09-08, so the margin was already down to tens of
         kilobytes and the app's own rendered markup spends that. Over the cap
         Node kills the child and throws ENOBUFS, which this helper reports as
         "chrome failed: … ENOBUFS" — a message that reads like a broken browser
         and sent one session hunting a Chromium fault that did not exist.
         WHY IT MATTERS BEYOND ONE SUITE: 33 suites drive this helper, so under
         the default cap the NEXT edit to m.html — any edit, of any size — turns
         all of them red at once and blames the browser for it. 64 MiB is not a
         guess about how big the DOM should get; it is far enough above any
         plausible document that growth stops being a tripwire. The 30s timeout
         above still bounds a genuinely runaway render. */
      out = execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox',
        '--window-size=500,940', '--virtual-time-budget=2500', '--dump-dom', 'file://' + file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000,
        maxBuffer: 64 * 1024 * 1024 });
    } catch (e) { failures.push(name); console.log(`  ✗ ${name}\n      chrome failed: ${e.message}`); continue; }
    const title = (out.match(/<title>([^<]*)<\/title>/) || [])[1] || 'no title';
    if (title === 'GOOD') { console.log(`  ✓ ${name} — ${checks.length} checks`); asserted += checks.length; }
    else {
      const bad = title.replace(/^BAD /, '').split(' ¦ ');
      console.log(`  ✗ ${name}`);
      for (const b of bad) console.log(`      ${b}`);
      failures.push(name);
      asserted += Math.max(0, checks.length - bad.length);
    }
  }

  fs.rmSync(dir, { recursive: true, force: true });
  if (failures.length) {
    console.error(`\n${failures.length} of ${cases.length} ${label} cases failed.`);
    process.exit(1);
  }
  console.log(`\nok — ${asserted} ${label} assertions across ${cases.length} cases.`);
}

module.exports = { run, findChrome, APP, inlineTdDatetime };
