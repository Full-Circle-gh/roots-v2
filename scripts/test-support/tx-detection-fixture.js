//
// tx-detection-fixture.js — a file with a KNOWN number of each transaction form,
// so that scripts/diagnose_async_conversion_scope.js --self-test has a case it
// can FAIL on.
//
// WHY THIS EXISTS
// ---------------
// The detector this fixture proves was wrong for four conversion batches and
// nobody noticed, because a detector that finds nothing looks exactly like a
// codebase that contains nothing. `withTransaction(h, fn)` is an Identifier
// callee; the detector matched `.transaction` as a member property only, so
// 26 converted blocks in routes/retail.js appeared in no figure it printed and
// every number it produced stayed plausible. A detector with no failing case is
// not proven — it is only unfalsified.
//
// THIS FILE IS NEVER EXECUTED. It is parsed. The functions below are shaped
// like real call sites and are deliberately not called by anything; running
// them would need a database and would prove nothing that parsing does not.
//
// THE KNOWN COUNTS — these are the assertions, and they are here rather than
// only in the runner so that editing this file forces you to restate them:
//
//   UNCONVERTED  `<handle>.transaction(...)`   7
//     u1  1   plain, invoked immediately
//     u2  1   assigned, then invoked via .immediate()
//     u3  1   body calls the shared helper
//     u4  2   NESTED — an inner block inside an outer one
//     u5  1   member handle rather than tdb()
//     u6  1   preceded ON THE SAME LINE by a string containing "//"
//
//   CONVERTED    `withTransaction(handle, body)`   5
//     c1  1   plain
//     c2  1   body calls the shared helper
//     c3  1   called through an IMPORT ALIAS, not the bare name
//     c4  2   NESTED — an inner block inside an outer one
//
//   DUAL CONTEXT  `touchOnce`
//     inside an unconverted block  1     (u3)
//     inside a converted block     1     (c2)
//     outside any transaction      1     (d1)
//
//     That third line is the whole point of the [8] correction. Before the fix
//     the helper read `inTx=1 outTx=2`, because a call inside a converted block
//     was indistinguishable from a call in no transaction at all.
//
//   NEGATIVES — every one of these must contribute ZERO to both forms:
//     both forms inside a line comment
//     both forms inside a block comment
//     both forms inside a string literal and a template literal
//     u6's leading URL string, which a comment stripper that is not
//       string-aware would treat as starting a comment, eating the real call
//       that follows it on that line
//
'use strict';

const { withTransaction } = require('../../lib/db-transaction');
// The SAME export under a different local name. A detector that hard-codes the
// bare identifier and stops there scores 4 instead of 5 here.
const { withTransaction: runTx } = require('../../lib/db-transaction');

let DB = null;
function tdb() { return DB; }
function setDb(d) { DB = d; }

// The shared db-touching helper. Called from three different contexts below,
// which is what makes the dual-context table testable.
function touchOnce(h) {
  return (h || tdb()).prepare('SELECT 1 AS ok').get();
}

// ── NEGATIVES ───────────────────────────────────────────────────────────────
// Neither of the next two lines is code, and neither may be counted:
// tdb().transaction(() => { tdb().prepare('nope').run(); })();
// await withTransaction(tdb(), async (tx) => { tx.prepare('nope').run(); });

/*
  Nor either of these:
  tdb().transaction(() => {})();
  withTransaction(tdb(), async () => {});
*/

// Nor these, which are data:
const NOTE_MEMBER_FORM = 'tdb().transaction(';
const NOTE_IDENT_FORM = `withTransaction(`;

// ── UNCONVERTED — better-sqlite3's db.transaction() ─────────────────────────

function u1() {
  return tdb().transaction(() => {
    tdb().prepare('INSERT INTO t (a) VALUES (?)').run(1);
  })();
}

function u2() {
  const t = tdb().transaction(() => {
    tdb().prepare('INSERT INTO t (a) VALUES (?)').run(2);
  });
  return t.immediate();
}

function u3(h) {
  return h.transaction(() => {
    touchOnce(h);
  })();
}

function u4() {
  return tdb().transaction(() => {
    tdb().prepare('INSERT INTO t (a) VALUES (?)').run(4);
    return tdb().transaction(() => {
      tdb().prepare('INSERT INTO t (a) VALUES (?)').run(41);
    })();
  })();
}

function u5() {
  return DB.transaction(() => {
    tdb().prepare('INSERT INTO t (a) VALUES (?)').run(5);
  })();
}

function u6() {
  // The string below ends in "//" characters that a naive stripper reads as the
  // start of a comment. Everything after it on this line would then vanish,
  // including the transaction on the next statement of the same line.
  const src = 'https://example.invalid/docs'; tdb().transaction(() => { tdb().prepare('INSERT INTO t (a) VALUES (?)').run(6); })();
  return src;
}

// ── CONVERTED — the withTransaction helper ──────────────────────────────────

async function c1() {
  return withTransaction(tdb(), async (tx) => {
    tx.prepare('INSERT INTO t (a) VALUES (?)').run(11);
  });
}

async function c2(h) {
  return withTransaction(h, async (tx) => {
    touchOnce(tx);
  });
}

// Through the alias. Same helper, same semantics, different identifier.
async function c3() {
  return runTx(tdb(), async (tx) => {
    tx.prepare('INSERT INTO t (a) VALUES (?)').run(13);
  });
}

async function c4() {
  return withTransaction(tdb(), async (tx) => {
    tx.prepare('INSERT INTO t (a) VALUES (?)').run(14);
    return withTransaction(tx, async (tx2) => {
      tx2.prepare('INSERT INTO t (a) VALUES (?)').run(141);
    });
  });
}

// ── OUTSIDE ANY TRANSACTION ─────────────────────────────────────────────────

function d1() {
  return touchOnce(null);
}

module.exports = {
  setDb, tdb, touchOnce,
  u1, u2, u3, u4, u5, u6,
  c1, c2, c3, c4,
  d1,
  NOTE_MEMBER_FORM, NOTE_IDENT_FORM,
};
