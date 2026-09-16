'use strict';

// Telling "this database has not been built yet" apart from "this database
// could not answer just now" — §151.
//
// WHY THIS EXISTS. An auth gate that wraps its user lookup in a try/catch is
// making a bet about what can go wrong in there. `requireRetailAdmin`'s bet was
// written for a first boot, where `tenant_users` does not exist yet and the
// gate must not 500 — and its catch therefore swallowed EVERYTHING, including
// `SQLITE_BUSY: database is locked` from an ordinary write elsewhere in the
// process. The operator was told they were not signed in, and the admin's fetch
// wrapper sends a 401 straight to /backend/login: a locked database logged
// somebody out mid-task.
//
// The two cases need different answers, so they need telling apart:
//   • schema not ready → the caller's own fall-through (the gate refuses, and
//     that refusal is correct: there is nobody to sign in as yet).
//   • anything else    → say so. 503 and a log line, never a sentence about
//     the operator's credentials.
//
// MATCHED ON THE MESSAGE, NOT THE CODE, and deliberately. better-sqlite3 gives
// `no such table: X` and `no such column: X` the generic code `SQLITE_ERROR`,
// which a constraint violation and a syntax error also carry — so the code
// cannot separate them and the message can. The match is narrow on purpose:
// anything it does not recognise is treated as a real failure, which is the
// safe direction. A missed match answers 503 to a first boot; the reverse would
// put the original bug back.
function schemaNotReady(err) {
  return /no such (table|column)\b/i.test(String((err && err.message) || ''));
}

module.exports = { schemaNotReady };
