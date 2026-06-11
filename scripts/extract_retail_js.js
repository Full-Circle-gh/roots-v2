// One-off: move the main inline <script> block (the ~17.5k-line app core)
// out of public/retail-admin.html into public/retail-admin.js, served at
// /assets/retail-admin.js. A plain <script src> at the same position keeps
// identical execution timing (classic script blocks the parser), so this is
// a pure mechanical move — no behavior change. Step 2a of the file split;
// see scripts/extract_retail_css.js for Step 1.
//
// Safety: verifies anchors + line accounting before writing; aborts on any
// mismatch without touching files. Run `node --check public/retail-admin.js`
// afterwards (the deploy gate also syntax-checks staged .js).
const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '..', 'public', 'retail-admin.html');
const jsPath = path.join(__dirname, '..', 'public', 'retail-admin.js');

const raw = fs.readFileSync(htmlPath, 'utf8');
if (!raw.includes('\r\n')) { console.error('ABORT: expected CRLF file'); process.exit(1); }
const lines = raw.split('\r\n');

// Anchor: the main block is the first line that is exactly '<script>' AFTER
// the rv-lightbox markup (the small bootstrap <script> in <head> comes first).
const lightboxIdx = lines.findIndex(l => l.includes('id="rv-lightbox-img"'));
if (lightboxIdx < 0) { console.error('ABORT: rv-lightbox anchor not found'); process.exit(1); }

const startIdx = lines.findIndex((l, i) => i > lightboxIdx && l.trim() === '<script>');
if (startIdx < 0) { console.error('ABORT: opening <' + 'script> not found'); process.exit(1); }

const endIdx = lines.findIndex((l, i) => i > startIdx && l.trim() === '</' + 'script>');
if (endIdx < 0) { console.error('ABORT: closing tag not found'); process.exit(1); }

const blockLines = endIdx - startIdx - 1;
if (blockLines < 15000 || blockLines > 20000) {
  console.error(`ABORT: block is ${blockLines} lines — expected ~17.5k. Wrong anchor?`);
  process.exit(1);
}
// The block must contain the app bootstrap to be the right one.
const body = lines.slice(startIdx + 1, endIdx);
if (!body.some(l => l.includes('const ICONS = {'))) {
  console.error('ABORT: block does not look like the app core (ICONS missing)');
  process.exit(1);
}
if (fs.existsSync(jsPath)) { console.error('ABORT: retail-admin.js already exists'); process.exit(1); }

fs.writeFileSync(jsPath, body.join('\r\n') + '\r\n', 'utf8');

const newLines = [
  ...lines.slice(0, startIdx),
  '<script src="/assets/retail-admin.js"></' + 'script>',
  ...lines.slice(endIdx + 1),
];
fs.writeFileSync(htmlPath, newLines.join('\r\n'), 'utf8');

console.log(`JS extracted: ${body.length} lines -> ${jsPath}`);
console.log(`HTML now: ${newLines.length} lines (was ${lines.length})`);
