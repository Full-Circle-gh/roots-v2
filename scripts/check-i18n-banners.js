'use strict';

// check-i18n-banners.js — refuse a bilingual label that swallows what follows it.
//
//   node scripts/check-i18n-banners.js
//
// THE BUG THIS EXISTS FOR, because it is invisible by construction.
//
// The admin renders one language at a time. Markup carries `EN · 中文` source
// pairs and a DOM walker splits them at runtime: processNode
// (public/retail-admin.html) finds the FIRST ' · ' in a text node, treats
// everything left of it as English and everything right as Chinese, and
// REPLACES the node with one side.
//
// So a line like
//
//     mount.innerHTML = `<div class="err">Failed · 失败: ${e.message}</div>`;
//
// puts the error message on the CHINESE side of the separator. The walker's
// MutationObserver fires the instant innerHTML inserts the node, the node
// becomes exactly "Failed", and the message is destroyed — for English readers
// only. In Chinese it survives, so it looks correct to half the people who
// could have noticed.
//
// That shipped in 29 places across four files and went unseen until a walk-in
// sale failed to open and the drawer said "Failed" and nothing else. Nobody
// could debug it, because the debugging information was the thing being eaten.
//
// TWO SANCTIONED SHAPES; this script exists to make everything else fail:
//
//   1. Resolve the label at call time — `${cuT('Failed', '失败')}: …`. No
//      separator reaches the node, so there is nothing to mis-split. Preferred,
//      because a pair that cannot be mis-split beats one marked exempt.
//   2. Put the dynamic half in its own element carrying data-no-i18n, which
//      inSkippedContext() skips wholesale. Shield the interpolated half only —
//      never the label, or the label ships glued, which is the same rule
//      arriving from the other side (tacet-desktop-patterns.md §1.11).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Every surface carrying this walker. app.html (the kitchen SPA) and
// product-editor.html were held back for one commit and are now in: each
// carries its own copy of processNode with the same ' · ' split, so each had
// the same bug, and a known defect left in place because it sat outside a
// scope line is one that comes back.
//
// cms.html and shop.html are absent on purpose, not by oversight: neither
// defines processNode. shop.html is the customer storefront and has no
// splitter at all; cms.html has one ' · ' read that is not this walker. A file
// with no walker cannot have this bug, and listing it would make the gate
// claim coverage it does not have.
const TARGETS = [
  'public/retail-admin',
  'public/retail-admin.html',
  'public/till.html',
  'public/app.html',
  'public/product-editor.html',
];

// A rendered bilingual pair: Latin, ' · ', Chinese. Then, BEFORE the next tag,
// an interpolation.
//
// The discriminator is the TEXT NODE, not the line. The walker replaces a text
// node, so only a hole landing in the SAME node can be swallowed — and a node
// ends at the next '<'. Excluding '<' from both runs is what separates the bug
// from its lookalikes, each of which was a real false positive while writing
// this:
//
//   '<option>All stores · 全部门店</option>' + next  → the tag closes first, safe
//   '<span>Uploaded · 上传于</span> ${when}'         → the hole is a sibling, safe
//   '点击"+ Add tag"创建。'                          → '"+' is prose, not code
//
// The concat arm therefore requires whitespace AND an identifier after the
// operator, so a quote-plus inside copy cannot masquerade as concatenation.
const PAIR_THEN_INTERP = new RegExp(
  "[A-Za-z][^'\"`<\\n]{0,80}? · [一-鿿][^'\"`<\\n]{0,80}?(\\$\\{|['\"]\\s+\\+\\s*[A-Za-z_$])"
);

// Only expressions that build HTML. A pair inside a toast() is a different
// case — one text node, no element to shield — and is out of scope by design.
const HTML_SINK = /\.innerHTML\s*=|insertAdjacentHTML\s*\(|\.outerHTML\s*=/;

function targetFiles(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [rel];
  return fs.readdirSync(abs)
    .filter((f) => f.endsWith('.js') || f.endsWith('.html'))
    .map((f) => (rel + '/' + f));
}

const files = TARGETS.flatMap(targetFiles);
const findings = [];

for (const rel of files) {
  const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!HTML_SINK.test(line)) continue;
    if (line.indexOf(' · ') === -1) continue;
    // data-no-i18n on the same line means the dynamic half is already shielded
    // (shape 2). Checked per LINE rather than by parsing, deliberately: this is
    // a lint, and a shield not visible beside the pair it protects is one
    // refactor away from being separated from it.
    if (line.indexOf('data-no-i18n') !== -1) continue;
    if (PAIR_THEN_INTERP.test(line)) {
      findings.push({ file: rel, line: i + 1, text: line.trim().slice(0, 150) });
    }
  }
}

if (findings.length) {
  console.log('FAIL  a bilingual pair swallows interpolated content\n');
  for (const f of findings) {
    console.log('  ' + f.file + ':' + f.line);
    console.log('    ' + f.text);
  }
  console.log('\n' + findings.length + " site(s). The walker splits on the FIRST ' · ' and keeps");
  console.log('one side, so everything after the Chinese is discarded for English readers.');
  console.log('Fix by resolving the label at call time:');
  console.log("    `${cuT('Failed', '失败')}: ${escapeHtml(e.message)}`");
  console.log('or move the interpolated half into its own [data-no-i18n] element.');
  process.exit(1);
}

console.log('PASS  ' + files.length + ' file(s) scanned — no bilingual pair swallows interpolated content.');
