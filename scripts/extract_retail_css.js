// One-shot: extract the giant <head> <style> block from retail-admin.html
// into public/retail-admin.css and replace it with a <link>. Leaves the
// small body-level <style> blocks (co-located with features) untouched.
const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '..', 'public', 'retail-admin.html');
const cssPath  = path.join(__dirname, '..', 'public', 'retail-admin.css');

const src = fs.readFileSync(htmlPath, 'utf8');

const open = src.indexOf('<style>');
if (open === -1) throw new Error('no <style> found');
const innerStart = open + '<style>'.length;
const close = src.indexOf('</style>', innerStart);
if (close === -1) throw new Error('no matching </style> found');

// Sanity: this first block must be the head block — </head> should follow shortly.
const afterClose = src.slice(close, close + 200);
if (!/<\/style>\s*<\/head>/.test(afterClose)) {
  throw new Error('first </style> is not immediately before </head>; aborting to be safe.\nSaw: ' + JSON.stringify(afterClose.slice(0, 80)));
}

const css = src.slice(innerStart, close);
// Trim one leading and trailing newline so the css file starts clean.
const cssTrimmed = css.replace(/^\r?\n/, '').replace(/\r?\n\s*$/, '\n');

const link = '<link rel="stylesheet" href="/assets/retail-admin.css">';
const newHtml = src.slice(0, open) + link + src.slice(close + '</style>'.length);

fs.writeFileSync(cssPath, cssTrimmed);
fs.writeFileSync(htmlPath, newHtml);

const lines = s => s.split('\n').length;
console.log('CSS extracted:', lines(cssTrimmed), 'lines ->', cssPath);
console.log('HTML now:', lines(newHtml), 'lines (was', lines(src) + ')');
