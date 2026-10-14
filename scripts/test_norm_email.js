#!/usr/bin/env node
/**
 * test_norm_email.js — one customer email, one spelling.
 *
 *   node scripts/test_norm_email.js
 *
 * WHAT IT GUARDS. normEmail() is how an email is stored and compared for a
 * customer: the manual-customer creator, the customer edit and the invoice
 * request all go through it. Dropping its lower-casing failed no suite, yet it
 * lets "Ann@Example.com" and "ann@example.com" become two customers and stops
 * a lookup by email finding the one already on file.
 *
 * THE REAL FUNCTION IS LIFTED FROM THE SOURCE AND RUN (retailSource() finds it
 * in routes/retail.js or in lib/ once it moves under decisions §477).
 */
'use strict';

const assert = require('assert');
const { retailSource } = require('./test-support/retail-source');

const SRC = retailSource();
const at = SRC.search(/^function normEmail\(/m);
assert.ok(at >= 0, 'function normEmail not found');
const normEmail = new Function(`${SRC.slice(at, SRC.indexOf('\n}', at) + 2)}\nreturn normEmail;`)();

let pass = 0, fail = 0;
const eq = (input, want, why) => {
  const got = normEmail(input);
  if (got === want) { pass++; console.log(`  ✓ ${why}`); }
  else { fail++; console.log(`  ✗ ${why}\n      ${JSON.stringify(input)} → ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};

console.log('\n1. one spelling per address');
eq('Ann@Example.COM', 'ann@example.com', 'upper case is folded to lower case');
eq('  ann@example.com \n', 'ann@example.com', 'surrounding spaces are trimmed');
eq(' ANN@EXAMPLE.COM ', normEmail('ann@example.com'), 'two spellings of one address store the same');

console.log('\n2. not an email is no email');
eq('', '', 'empty stays empty');
eq(null, '', 'missing is empty');
eq('ann', '', 'no @ is refused');
eq('ann@example', '', 'no dot after the @ is refused');
eq('ann smith@example.com', '', 'a space inside is refused');
eq('ann@@example.com', '', 'two @ are refused');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
