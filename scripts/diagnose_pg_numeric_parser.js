#!/usr/bin/env node
// GAP G27. Nothing but server.js used to parse .env, so this script saw no
// TACET_PG_* and lib/pg refused to build a pool -- an environment failure
// wearing the clothes of a data finding. Loaded here, before anything reaches
// for a connection, so a missing variable is reported as a missing variable.
require('../lib/load-env').loadEnv();
//
// diagnose_pg_numeric_parser.js — proves the read-side money converter in
// lib/pg.js against the LIVE PostgreSQL `tacet` database.
//
// WHAT IT PROVES, with real values rather than assertions about them:
//   1. a money value from a numeric(14,6) column arrives as a JS NUMBER, and
//      agrees to 6dp with what PostgreSQL itself renders that value as
//   2. the numeric(14,6) ceiling, 99,999,999.999999, round-trips exactly
//   3. SUM() over a money column returns correctly — the unbounded-expression
//      case the guard exists for
//   4. a numeric expression beyond JS safe range comes back as a STRING, not a
//      corrupted number, including a SUM() that crosses the boundary
//   5. SQL NULL stays null
//
// HOW IT IS READ-ONLY, AND WHY THAT IS ENFORCED RATHER THAN INTENDED. Every
// statement runs inside `BEGIN TRANSACTION READ ONLY`, so PostgreSQL itself
// rejects any write, and the transaction is ROLLBACKed at the end. Nothing here
// creates, alters or inserts anything. The only tables read are `products` and
// `ingredients`, and only to pick existing values to feed through the parser.
//
// THE COMPARISON THAT MAKES THIS A PROOF. For each money value the query asks
// PostgreSQL for the same value twice: once as `numeric` (which the driver hands
// to our parser as text) and once cast `::text` (OID 25, which the parser never
// touches). If our parsed number and PostgreSQL's own rendering agree, the
// conversion is right — the database's opinion is the reference, not ours.
//
// RUN IT (on the box, as the postgres OS user — pg_hba is `peer` on the socket
// and the postgres role has no password, so this is the only path in):
//
//   TACET_PG_HOST=/var/run/postgresql TACET_PG_DATABASE=tacet \
//   TACET_PG_USER=postgres node scripts/diagnose_pg_numeric_parser.js
//
// Read-only. Touches no schema, no data, and no application file.

'use strict';

const { pool, parseNumericText } = require('../lib/pg');

function show(label, value) {
  const t = value === null ? 'null' : typeof value;
  const shown = typeof value === 'string' ? JSON.stringify(value) : String(value);
  console.log(`    ${label.padEnd(30)} ${shown.padEnd(26)} typeof=${t}`);
}

let failures = 0;
function expect(cond, why) {
  if (!cond) { failures++; console.log(`    *** UNEXPECTED: ${why}`); }
}

async function main() {
  console.log('read-side money converter — live PostgreSQL proof');
  console.log('database:', process.env.TACET_PG_DATABASE, ' host:', process.env.TACET_PG_HOST);

  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const ro = await client.query('SHOW transaction_read_only');
    console.log('transaction_read_only =', ro.rows[0].transaction_read_only);
    expect(ro.rows[0].transaction_read_only === 'on', 'transaction is not read-only');

    // ── 0. the registration actually took effect ────────────────────────────
    console.log('\n[0] the parser is registered for OID 1700');
    const probe = await client.query('SELECT 1.5::numeric AS v');
    show('SELECT 1.5::numeric', probe.rows[0].v);
    expect(typeof probe.rows[0].v === 'number', '1.5::numeric did not arrive as a number');
    const fields = probe.fields.map((f) => `${f.name}:oid=${f.dataTypeID}`).join(', ');
    console.log('    field types reported by driver:', fields);
    expect(probe.fields[0].dataTypeID === 1700, 'column was not OID 1700');

    // ── 1. real money values, checked against PostgreSQL's own rendering ────
    console.log('\n[1] real money values — parsed number vs PostgreSQL ::text');
    const money = await client.query(`
      SELECT 'products.sell_price' AS src, id, sell_price AS num, sell_price::text AS as_text
        FROM products
       WHERE sell_price IS NOT NULL AND sell_price > 0
       ORDER BY sell_price DESC
       LIMIT 2
    `);
    for (const r of money.rows) {
      console.log(`  ${r.src} id=${r.id}`);
      show('parsed (numeric)', r.num);
      show('PostgreSQL ::text', r.as_text);
      expect(typeof r.num === 'number', `${r.src} did not arrive as a number`);
      expect(Number(r.as_text) === r.num, `${r.src} parsed value disagrees with ::text`);
      expect(r.num.toFixed(6) === r.as_text, `${r.src} toFixed(6) != ::text`);
    }

    // a value with genuine sub-cent precision — the deepest real case
    console.log('\n[1b] genuine 6dp precision (ingredients.cost_per_unit)');
    const deep = await client.query(`
      SELECT id, cost_per_unit AS num, cost_per_unit::text AS as_text
        FROM ingredients
       WHERE cost_per_unit IS NOT NULL
         AND cost_per_unit <> round(cost_per_unit, 2)
       ORDER BY cost_per_unit DESC
       LIMIT 2
    `);
    if (!deep.rows.length) console.log('    (no sub-cent values found)');
    for (const r of deep.rows) {
      console.log(`  ingredients.cost_per_unit id=${r.id}`);
      show('parsed (numeric)', r.num);
      show('PostgreSQL ::text', r.as_text);
      expect(typeof r.num === 'number', 'cost_per_unit did not arrive as a number');
      expect(r.num.toFixed(6) === r.as_text, 'cost_per_unit toFixed(6) != ::text');
    }

    // ── 2. the numeric(14,6) ceiling ────────────────────────────────────────
    console.log('\n[2] the numeric(14,6) ceiling round-trips exactly');
    const ceil = await client.query(`
      SELECT 99999999.999999::numeric(14,6) AS num,
             99999999.999999::numeric(14,6)::text AS as_text
    `);
    show('parsed', ceil.rows[0].num);
    show('PostgreSQL ::text', ceil.rows[0].as_text);
    expect(typeof ceil.rows[0].num === 'number', 'ceiling did not arrive as a number');
    expect(ceil.rows[0].num.toFixed(6) === ceil.rows[0].as_text, 'ceiling did not round-trip');

    // ── 3. SUM() over a money column — the unbounded-expression case ────────
    console.log('\n[3] SUM() over a money column');
    const sum = await client.query(`
      SELECT COUNT(*) AS n, SUM(sell_price) AS num, SUM(sell_price)::text AS as_text
        FROM products WHERE sell_price IS NOT NULL
    `);
    show('COUNT(*) [bigint→text]', sum.rows[0].n);
    show('SUM(sell_price) parsed', sum.rows[0].num);
    show('SUM ::text', sum.rows[0].as_text);
    expect(typeof sum.rows[0].num === 'number', 'SUM did not arrive as a number');
    expect(Number(sum.rows[0].as_text) === sum.rows[0].num, 'SUM disagrees with ::text');

    // ── 4. beyond JS safe range — must stay TEXT, never a corrupted number ──
    console.log('\n[4] beyond JS safe range — stays a string');
    console.log('    Number.MAX_SAFE_INTEGER =', Number.MAX_SAFE_INTEGER);
    const big = await client.query(`
      SELECT 9007199254740993::numeric              AS just_over,
             12345678901234567890.123456::numeric   AS very_big,
             (SELECT SUM(x) FROM (VALUES (9007199254740991::numeric),
                                        (10::numeric)) t(x)) AS sum_crosses
    `);
    for (const k of ['just_over', 'very_big', 'sum_crosses']) {
      const v = big.rows[0][k];
      show(k, v);
      expect(typeof v === 'string', `${k} was parsed to a number and may be corrupted`);
    }
    console.log('    for contrast, what Number() would have done to just_over:',
      Number('9007199254740993'));

    // ── 5. NULL ─────────────────────────────────────────────────────────────
    console.log('\n[5] SQL NULL');
    const nul = await client.query('SELECT NULL::numeric AS n');
    show('NULL::numeric', nul.rows[0].n);
    expect(nul.rows[0].n === null, 'NULL::numeric did not come back as null');

    // ── 6. the pure function, on the same boundary ──────────────────────────
    console.log('\n[6] parseNumericText() directly, at the boundary');
    for (const s of ['9007199254740991', '9007199254740992', '0.000001', '0.000000', '-12.340000']) {
      show(`parseNumericText(${JSON.stringify(s)})`, parseNumericText(s));
    }
    show('parseNumericText(null)', parseNumericText(null));

    await client.query('ROLLBACK');
    console.log('\ntransaction rolled back — nothing was written.');
  } finally {
    client.release();
    await pool.end();
  }

  console.log(failures ? `\nUNEXPECTED RESULTS: ${failures}` : '\nAll observed values matched expectations.');
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => { console.error('\nFAILED:', e.message); process.exitCode = 1; });
