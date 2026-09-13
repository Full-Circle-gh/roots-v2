// Composes each .dc.html artboard from _base.css + a body fragment, so the
// four boards can never drift apart on tokens. Re-run after editing any part:
//   node build.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const css = readFileSync(new URL('./_base.css', import.meta.url), 'utf8');
const frag = (n) => readFileSync(new URL(`./parts/${n}.html`, import.meta.url), 'utf8');

const page = (extraCss, bodyHtml) => `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&display=swap">
  <style>
${css}${extraCss}
  </style>
</helmet>
${bodyHtml}
</x-dc>
</body>
</html>
`;

for (const [file, extra] of [
  ['Diagnosis', frag('diagnosis-css')],
  ['Main', ''],
  ['OptionA', ''],
  ['OptionC', frag('optionc-css')],
]) {
  writeFileSync(new URL(`./${file}.dc.html`, import.meta.url), page(extra, frag(file)));
  console.log('wrote', file + '.dc.html');
}
