// The text of routes/retail.js and every part split out of it, as one string.
//
// WHY THIS EXISTS (decisions §470). About 45 suites read routes/retail.js as
// text and slice a handler out of it to check how it is written. When an area
// moves into routes/retail/<area>.js, a check that read retail.js alone would
// find nothing and fail, though nothing broke. Reading the whole family as one
// text lets a check follow the code it is about without being told where the
// code lives today. The check itself stays exactly as strict as it was.
//
// Parts are read in name order after retail.js, each separated by a blank line,
// so a slice that ends at '\n});' cannot run from one file into the next.
// Line endings are normalised to \n whatever the checkout wrote.
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const PARTS_DIR = path.join(REPO, 'routes', 'retail');

function retailPartFiles() {
  if (!fs.existsSync(PARTS_DIR)) return [];
  return fs.readdirSync(PARTS_DIR).filter((f) => f.endsWith('.js')).sort()
    .map((f) => path.join('routes', 'retail', f));
}

function retailSource() {
  return ['routes/retail.js', ...retailPartFiles()]
    .map((rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n'))
    .join('\n\n');
}

module.exports = { retailSource, retailPartFiles };
