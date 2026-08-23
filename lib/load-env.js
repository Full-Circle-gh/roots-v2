'use strict';
// ── The .env loader, extracted so it is not the server's private property ────
//
// GAP G27. This was an IIFE inside server.js and nothing else parsed .env, so
// every script that reached for a TACET_PG_* variable found nothing and
// lib/pg refused to build a pool. That broke four steps of the cutover runbook
// — G6, PART H's T1, the H4 slow loop and H6's delta report — and it broke
// them at the worst possible moment: T1's exit-2 rule escalates to RED, so the
// panel would have ordered a rollback within two minutes of the flip for a
// configuration reason.
//
// WHY THIS IS A MODULE AND NOT A SHELL WRAPPER. `.env` is not shell-sourceable.
// A line whose value contains an unquoted `<` — line 63 of the live file does —
// makes `set -a; . .env` fail as a REDIRECTION, part-way through, having
// already exported everything above it. A partial environment is worse than an
// empty one: lib/pg's REQUIRED check passes on three variables while a fourth
// the caller needed is silently absent. Parsing it in JS, with the same code
// the server uses, cannot half-succeed.
//
// THE FORMAT, unchanged from the original: KEY=value per line, `#` comments,
// blank lines fine, optional surrounding quotes stripped, and EXISTING
// process.env WINS so pm2's --update-env still overrides the file.
//
// Callers get a report rather than a promise. sourced=false with an error is a
// caller's problem to escalate, not this module's to swallow — but it never
// throws, because a loader that crashes the process it was meant to configure
// is worse than the gap it closed.

const fs = require('fs');
const path = require('path');

// __dirname is lib/, so the repo root is one up. server.js used
// path.join(__dirname, '.env') from the root and this must resolve to the same
// absolute path — proven by scripts/test_load_env.js, not assumed.
const ENV_PATH = path.join(__dirname, '..', '.env');

function loadEnv(opts) {
  const envPath = (opts && opts.path) || ENV_PATH;
  const res = { path: envPath, sourced: false, applied: 0, skipped: 0, error: null };
  try {
    if (!fs.existsSync(envPath)) return res;
    const text = fs.readFileSync(envPath, 'utf8');
    res.sourced = true;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      // Strip optional surrounding quotes (so KEY="value" works too).
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) { process.env[key] = val; res.applied += 1; }
      else res.skipped += 1;
    }
  } catch (e) {
    // Same swallow-and-warn the server has always had. Recorded on the result
    // so a script can turn it into a refusal; the server continues to ignore it
    // exactly as before.
    res.error = e.message;
    console.warn('[.env load]', e.message);
  }
  return res;
}

// For the scripts, which must not start work on a config they never read. This
// is the whole point of the extraction: a missing .env has to be
// DISTINGUISHABLE from a real finding, and the only way to do that is to refuse
// before the work starts rather than fail somewhere inside it.
//
// `need` is the list of variables the caller genuinely cannot proceed without.
// Returns the load report on success; on failure it prints why and exits 2 —
// the conventional "this instrument could not run" code across this repo,
// deliberately NOT 1, which means "it ran and found something".
function requireEnv(need, who) {
  const rep = loadEnv();
  const missing = (need || []).filter((k) => !process.env[k]);
  if (!missing.length) return rep;
  const label = who || 'load-env';
  console.error(`[${label}] REFUSING TO RUN: missing ${missing.join(', ')}.`);
  console.error(rep.sourced
    ? `  ${rep.path} was read (${rep.applied} set, ${rep.skipped} already in the environment) `
      + 'but does not define the variable(s) above.'
    : `  ${rep.path} does not exist${rep.error ? ` (${rep.error})` : ''}.`);
  console.error('  THIS IS NOT A FINDING ABOUT YOUR DATA. Nothing was measured.');
  process.exit(2);
}

module.exports = { loadEnv, requireEnv, ENV_PATH };
