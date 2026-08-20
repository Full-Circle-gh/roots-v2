// Which database driver this process talks to. Read once, at module load.
//
// This is G2. It is the single decision the whole cutover turns on, and it is
// deliberately the smallest module in the tree: it reads one variable, validates
// it, says what it chose, and exports a constant. It opens nothing, requires no
// driver, and cannot fail for any reason other than a bad value.
//
// ── THE SHAPE, AND WHY THIS ONE ──────────────────────────────────────────
// Read once at module load and exported as a constant — the shape
// lib/tenant-db.js:87 already uses for TENANT_DATA_ISOLATION, and the one
// decisions §24 (CUTOVER SEQUENCING) specified for this flag. Not a function, not
// a getter, not re-read per request. 47 runtime files bind the database handle at
// require time rather than per call, so a decision that can change after boot
// would reach some of them and not others. One process, one driver, decided
// before the first handle exists.
//
// ── MISSING IS NOT AN ERROR. AN UNRECOGNISED VALUE IS. ───────────────────
// These two cases are not symmetric and are deliberately not treated the same.
//
//   MISSING  -> sqlite, logged. Every process in production has TACET_DB unset
//     today. If absence were fatal, the first deploy carrying this file would
//     refuse to boot everywhere at once — a self-inflicted outage caused by
//     shipping a flag, before anybody had decided to flip anything. Absence
//     means "nobody has asked for a change", and the honest answer to that is
//     today's behaviour.
//
//   UNRECOGNISED -> throw, at load, before any handle is built. `postgresql`,
//     `pg`, `postgre`, `Postgres!` are all near-misses for the value someone
//     MEANT to set, and a near-miss is indistinguishable from unset unless it is
//     refused. Silently treating it as sqlite is the worst outcome available:
//     the operator believes the flip happened, the application keeps writing to
//     SQLite, and the divergence that follows needs a reverse copy that does not
//     exist (G22). lib/pg.js already refuses to build a pool on missing config
//     for the same reason, in its own words — "a missing or stray variable would
//     then connect somewhere unintended rather than failing". Same rule here.
//
// Whitespace is trimmed and case is folded, because ` postgres ` and `POSTGRES`
// are not near-misses — they are the right answer typed by a human or left by a
// .env parser, and refusing them buys nothing. `postgresql` is a different word
// and is refused. The line between the two is: same token, or not.
//
// ── THE BOOT LINE IS PART OF THE CONTRACT ────────────────────────────────
// The driver is announced on stdout at load. That line exists so the flip step
// can ASSERT which driver came up instead of assuming it did.
// `pm2 restart --update-env` has silently dropped a variable before — it wiped
// PORT and the process came back on the wrong port — so "we set it and
// restarted" is not evidence that the process read it.
'use strict';

const SQLITE = 'sqlite';
const POSTGRES = 'postgres';
const VALID = new Set([SQLITE, POSTGRES]);

const rawValue = process.env.TACET_DB;
const normalised = typeof rawValue === 'string' ? rawValue.trim().toLowerCase() : '';

let DRIVER;
let SOURCE;

if (normalised === '') {
  DRIVER = SQLITE;
  SOURCE = 'default (TACET_DB not set)';
  console.log(
    `[db-driver] TACET_DB is not set — driver: ${SQLITE} (default). ` +
    `This is the pre-flip state and is not a warning. Set TACET_DB=${POSTGRES} to select Postgres.`
  );
} else if (VALID.has(normalised)) {
  DRIVER = normalised;
  SOURCE = `TACET_DB=${rawValue}`;
  console.log(`[db-driver] TACET_DB=${rawValue} — driver: ${DRIVER}`);
} else {
  // Thrown, not logged-and-defaulted. See the header: a value that is present
  // and wrong is somebody trying to select something, and guessing what they
  // meant is exactly how a flip silently does not happen.
  throw new Error(
    `[db-driver] TACET_DB is set to ${JSON.stringify(rawValue)}, which is not a driver this ` +
    `application knows. Valid values: ${[...VALID].join(', ')} (case and surrounding whitespace ` +
    `are ignored; nothing else is). Refusing to boot rather than guessing — a near-miss value ` +
    `treated as a default is indistinguishable from the flag never being set, and the flip would ` +
    `silently not happen. Unset TACET_DB to select ${SQLITE}.`
  );
}

module.exports = {
  DRIVER,
  SOURCE,
  IS_SQLITE: DRIVER === SQLITE,
  IS_POSTGRES: DRIVER === POSTGRES,
  SQLITE,
  POSTGRES,
  VALID_VALUES: Object.freeze([...VALID]),
};
