#!/usr/bin/env node
/**
 * Side-by-side proof that routing a BATCH of modules through the database seam
 * (lib/db-seam.js) changed nothing. Generalises scripts/diagnose_store_hours_seam.js
 * so each round reuses one harness instead of growing a new copy per batch.
 *
 * THE SHAPE OF THE PROOF
 * ----------------------
 * Three independent checks, because no one of them is sufficient:
 *
 *   1. CAPABILITY AUDIT (static). The seam intercepts prepare() and forwards
 *      everything else. So a module is only safe to route if every handle member
 *      and every statement member it uses is in the proven set. A module reaching
 *      for something outside it is reported and must be looked at by hand rather
 *      than shipped.
 *
 *   2. LOAD THROUGH THE SEAM. Each module is required twice against the same
 *      read-only connection — once with lib/db-seam.js stubbed to the identity
 *      function (byte-for-byte its previous behaviour), once with the real seam —
 *      and both must load without throwing.
 *
 *   3. EXECUTION, RAW vs WRAPPED, ON LIVE DATA. Where a module's reads can be
 *      driven through its own exported functions, they are. Where the statements
 *      sit behind an HTTP handler, the harness holds a VERBATIM copy of the SQL
 *      and asserts that copy still appears in the source file, so a statement that
 *      changes fails here loudly instead of being silently tested in a stale form.
 *      That is the same tie-to-source pattern diagnose_money_unit_split.js uses.
 *
 * SWALLOWED ERRORS ARE THE REASON THE NO-THROW CHECK IS EXPLICIT
 * -------------------------------------------------------------
 * Several modules in this batch catch their own database errors and carry on:
 * lib/operator-caps.js resolves capabilities FAIL-OPEN when its read throws, and
 * lib/require-cap.js swallows the tenants read. A seam fault there would not
 * surface as an error — it would surface as different permissions. So a probe sits
 * underneath the seam and records every exception the handle raises whether or not
 * the module swallows it, and the seam is separately driven with no try/catch in
 * the way.
 *
 * The database is opened read-only and PROVEN read-only before anything runs.
 * database.js is never executed — it issues DDL at load — it is replaced in the
 * module cache by the read-only handle.
 *
 * Run: node scripts/diagnose_seam_batch.js
 *      (via .github/workflows/ro-query.yml, which stages this checkout's lib/)
 */
'use strict';

const path = require('path');
const fs = require('fs');

const HOME = process.env.ROOTS_HOME || '/root/roots-v2';
const DB_PATH = process.env.ROOTS_DB || path.join(HOME, 'data', 'roots.db');
const Database = require(path.join(HOME, 'node_modules', 'better-sqlite3'));

const DATABASE_JS = path.join(HOME, 'database.js');
const DB_SEAM_JS = path.join(HOME, 'lib', 'db-seam.js');

// ── The batch ───────────────────────────────────────────────────────────────
// Every module routed through the seam in this round. `reads` are exercised
// through the module's own exports; `statements` are verbatim copies tied to the
// source for statements that sit behind a handler. `unexercised` is declared, not
// discovered — anything listed there is reported as NOT covered by the live run.
const BATCH = [
  {
    file: 'lib/integrations/session-relay.js',
    why: 'three sites, lowest traffic, and the only one in this batch with a write',
    reads: (mod, db) => {
      const row = db.prepare('SELECT tenant_id, kind, store_code FROM integration_sessions LIMIT 1').get();
      const t = row ? row.tenant_id : 1;
      const k = row ? row.kind : 'meituan';
      const s = row ? row.store_code : '__absent__';
      return {
        getSession_real: mod.getSession(t, k, s),
        getSession_absent: mod.getSession(t, k, '__no_such_store__'),
        summary_real: mod.summary(t, k),
        summary_absent: mod.summary(-1, k),
      };
    },
    // The write path. It cannot run against the live read-only connection and must
    // not run against live data, so §6 gives each side its own scratch database in
    // the OS temp directory. The module's own DDL builds the schema there, so this
    // exercises the real upsert rather than a hand-copied imitation.
    writeCheck: {
      via: 'markExpired() → writeSession() → INSERT ... ON CONFLICT DO UPDATE',
      // integration_sessions carries FOREIGN KEY (tenant_id) REFERENCES tenants(id),
      // and better-sqlite3 turns foreign keys ON by default, so the parent table has
      // to exist in the scratch database before the module's DDL is any use.
      schema: (h) => {
        h.exec('CREATE TABLE IF NOT EXISTS tenants (id INTEGER PRIMARY KEY, name TEXT)');
        h.prepare('INSERT OR IGNORE INTO tenants (id, name) VALUES (1, ?)').run('scratch');
      },
      run: (mod) => {
        mod.markExpired(1, 'meituan', 'yuexiu', 'boom');
        mod.markExpired(1, 'meituan', 'tianhe', null);
        mod.markExpired(1, 'meituan', 'yuexiu', 'second time — must UPDATE, not INSERT');
      },
      // Timestamp columns are excluded: they are wall-clock and would differ
      // between the two runs for reasons that have nothing to do with the seam.
      dump: (h) => h.prepare(
        'SELECT tenant_id, kind, store_code, status, last_error FROM integration_sessions ORDER BY store_code'
      ).all(),
    },
    unexercised: [
      'startLogin() and submitSms() — they drive a login through a registered ' +
      'driver, which reaches an external service. Both write via the same ' +
      'writeSession() upsert that §5 covers.',
    ],
  },
  {
    file: 'routes/events.js',
    why: 'two sites, an admin-only diagnostic endpoint, no write',
    // Both statements live inside GET /api/events/who-is-listening, behind
    // requireAuth + requireAdmin. Driving express and its auth middleware inside a
    // diagnostic is more fragile than the statements are complex, so they are
    // compared directly and tied to the source below.
    statements: [
      {
        name: 'markets lookup by name',
        sql: `
      SELECT id, name, name_cn, COALESCE(kind,'market') AS kind, is_active
        FROM markets
       WHERE COALESCE(is_active,1) = 1
         AND (LOWER(TRIM(name)) = LOWER(TRIM(?)) OR (name_cn IS NOT NULL AND TRIM(name_cn) = TRIM(?)))
       LIMIT 1
    `,
        method: 'get',
        params: (db) => {
          const m = db.prepare('SELECT name FROM markets WHERE COALESCE(is_active,1)=1 LIMIT 1').get();
          return [m ? m.name : '__absent__', m ? m.name : '__absent__'];
        },
      },
      {
        name: 'users assigned to a market',
        sql: `
        SELECT id, username, display_name, role
          FROM users
         WHERE market_id = ? AND COALESCE(is_active,1) = 1
         ORDER BY display_name, username
      `,
        method: 'all',
        params: (db) => {
          const m = db.prepare('SELECT id FROM markets WHERE COALESCE(is_active,1)=1 LIMIT 1').get();
          return [m ? m.id : -1];
        },
      },
    ],
    unexercised: [],
  },
];

// Handle members the seam is proven to pass through, and statement members it is
// proven to wrap. A module using anything outside these is not safe to route
// without a fresh look, so the audit fails rather than warns.
const SAFE_HANDLE_MEMBERS = new Set(['prepare', 'exec', 'pragma', 'transaction', 'name', 'open', 'inTransaction', 'readonly']);
const SAFE_STMT_MEMBERS = new Set(['get', 'all', 'run', 'iterate', 'pluck', 'expand', 'raw', 'columns', 'bind', 'safeIntegers', 'reader', 'source', 'busy']);

for (const f of [DB_SEAM_JS, DATABASE_JS]) {
  if (!fs.existsSync(f)) { console.error('FATAL: missing ' + f); process.exit(2); }
}
for (const m of BATCH) {
  const abs = path.join(HOME, m.file);
  if (!fs.existsSync(abs)) { console.error('FATAL: missing ' + abs); process.exit(2); }
}

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

let proven = false;
try {
  db.exec('CREATE TABLE __ro_probe__ (x)');
} catch (e) {
  proven = true;
  console.log('read-only PROVEN — write rejected: ' + e.message);
}
if (!proven) {
  console.error('FATAL: the connection accepted a write. Aborting without comparing anything.');
  process.exit(2);
}
console.log('db: ' + DB_PATH);
console.log('sqlite: ' + db.prepare('select sqlite_version() v').get().v);
console.log('batch: ' + BATCH.map(b => b.file).join(', '));

let FAILURES = 0;
const fail = (msg) => { FAILURES++; console.log('   FAIL  ' + msg); };
const ok = (msg) => console.log('   ok    ' + msg);

// ── Probe: observes what the handle was actually asked to do ────────────────
function probeHandle(real) {
  const log = { sql: [], errors: [] };
  const wrapStmt = (stmt, sql) => new Proxy(stmt, {
    get(t, p) {
      const v = Reflect.get(t, p, t);
      if (typeof v !== 'function') return v;
      return (...a) => {
        try { const out = v.apply(t, a); return out === t ? wrapStmt(t, sql) : out; }
        catch (e) { log.errors.push({ phase: String(p), sql, message: e.message }); throw e; }
      };
    },
  });
  const handle = new Proxy(real, {
    get(t, p) {
      const v = Reflect.get(t, p, t);
      if (typeof v !== 'function') return v;
      if (p !== 'prepare') return v.bind(t);
      return (sql, ...rest) => {
        log.sql.push(sql);
        try { return wrapStmt(v.apply(t, [sql, ...rest]), sql); }
        catch (e) { log.errors.push({ phase: 'prepare', sql, message: e.message }); throw e; }
      };
    },
  });
  return { handle, log };
}

// ── Load a module against a chosen seam ─────────────────────────────────────
function loadModule(relFile, { identitySeam, into }) {
  const abs = path.join(HOME, relFile);
  const { handle, log } = probeHandle(into || db);

  // Clear the module and everything it may have pulled in, so the two runs never
  // share a cached instance or a module-level cache.
  for (const id of Object.keys(require.cache)) {
    if (id.startsWith(HOME)) delete require.cache[id];
  }

  require.cache[DATABASE_JS] = {
    id: DATABASE_JS, filename: DATABASE_JS, loaded: true, children: [], paths: [], exports: handle,
  };
  if (identitySeam) {
    require.cache[DB_SEAM_JS] = {
      id: DB_SEAM_JS, filename: DB_SEAM_JS, loaded: true, children: [], paths: [],
      exports: { seam: (h) => h, unwrap: (h) => h, isWrapped: () => false, currentConverter: () => null },
    };
  }

  let mod = null, threw = null;
  try { mod = require(abs); } catch (e) { threw = e; }
  return { mod, log, threw };
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 1 · capability audit — does each module stay inside what the seam proves? ══');

function membersUsed(src) {
  // Strip comments and string bodies so prose and SQL never register as calls.
  let code = '', i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; code += ' '; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') { i += 2; continue; } i++; }
      i++; continue;
    }
    code += c; i++;
  }
  const dbNames = new Set();
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\([^)]*database[^)]*\)/g)) dbNames.add(m[1]);
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*seam\(/g)) dbNames.add(m[1]);

  const handleMembers = new Set(), stmtMembers = new Set();
  for (const name of dbNames) {
    for (const m of code.matchAll(new RegExp(`\\b${name}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g'))) handleMembers.add(m[1]);
  }
  // Statement members: whatever is called on the result of prepare(...).
  let idx = -1;
  while ((idx = code.indexOf('.prepare(', idx + 1)) !== -1) {
    let j = idx + '.prepare('.length, depth = 1;
    while (j < code.length && depth > 0) {
      if (code[j] === '(') depth++;
      else if (code[j] === ')') depth--;
      j++;
    }
    const after = code.slice(j).match(/^\s*\.\s*([A-Za-z_$][\w$]*)/);
    if (after) stmtMembers.add(after[1]);
  }
  return { dbNames, handleMembers, stmtMembers };
}

for (const item of BATCH) {
  const src = fs.readFileSync(path.join(HOME, item.file), 'utf8');
  const { handleMembers, stmtMembers } = membersUsed(src);
  const badH = [...handleMembers].filter(m => !SAFE_HANDLE_MEMBERS.has(m));
  const badS = [...stmtMembers].filter(m => !SAFE_STMT_MEMBERS.has(m));
  const desc = `${item.file}  handle:{${[...handleMembers].sort().join(',')}} stmt:{${[...stmtMembers].sort().join(',')}}`;
  if (badH.length || badS.length) fail(`${desc}  OUTSIDE THE PROVEN SET: ${[...badH, ...badS].join(',')}`);
  else ok(desc);
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 2 · every module loads through the seam without throwing ══');

const loaded = new Map();
for (const item of BATCH) {
  const RAW = loadModule(item.file, { identitySeam: true });
  const WRAPPED = loadModule(item.file, { identitySeam: false });
  loaded.set(item.file, { RAW, WRAPPED });
  if (RAW.threw) fail(`${item.file} RAW threw at require: ${RAW.threw.message}`);
  if (WRAPPED.threw) fail(`${item.file} WRAPPED threw at require: ${WRAPPED.threw.message}`);
  if (!RAW.threw && !WRAPPED.threw) ok(`${item.file} loaded both ways`);
}

// The seam itself, driven with no try/catch in the way — catches a fault that
// originates inside the seam, which a probe sitting underneath it cannot see.
{
  delete require.cache[DB_SEAM_JS];
  const seamMod = require(DB_SEAM_JS);
  let threw = null;
  try { seamMod.seam(db).prepare('SELECT 1 AS x').get(); } catch (e) { threw = e; }
  if (threw) fail('the seam threw on a trivial statement: ' + threw.message);
  else ok('the seam executes a statement without throwing');
  if (seamMod.currentConverter() !== null) fail('a converter is installed; this step must ship with none');
  else ok('no converter installed — seam is a passthrough, as designed');
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 3 · reads exercised through the modules\' own exports, raw vs wrapped ══');

for (const item of BATCH) {
  if (!item.reads) { console.log(`   --    ${item.file}: no callable read exercise (see §4)`); continue; }
  const { RAW, WRAPPED } = loaded.get(item.file);
  if (!RAW.mod || !WRAPPED.mod) { fail(`${item.file}: a path did not load; nothing exercised`); continue; }

  let a = null, b = null, ea = null, eb = null;
  try { a = item.reads(RAW.mod, db); } catch (e) { ea = e; }
  try { b = item.reads(WRAPPED.mod, db); } catch (e) { eb = e; }

  if (ea) fail(`${item.file}: RAW exercise threw: ${ea.message}`);
  if (eb) fail(`${item.file}: WRAPPED exercise threw: ${eb.message}`);
  if (ea || eb) continue;

  if (JSON.stringify(a) === JSON.stringify(b)) {
    ok(`${item.file}: ${Object.keys(a).length} exercise(s) identical`);
  } else {
    fail(`${item.file}: exercise results differ`);
    for (const k of Object.keys(a)) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
        console.log(`         ${k}\n           RAW     : ${JSON.stringify(a[k]).slice(0, 200)}`);
        console.log(`           WRAPPED : ${JSON.stringify(b[k]).slice(0, 200)}`);
      }
    }
  }

  // SQL issued must match, and nothing may have raised beneath the seam.
  if (JSON.stringify(RAW.log.sql) !== JSON.stringify(WRAPPED.log.sql)) {
    fail(`${item.file}: the seam changed the SQL issued`);
    console.log('         RAW     : ' + JSON.stringify(RAW.log.sql));
    console.log('         WRAPPED : ' + JSON.stringify(WRAPPED.log.sql));
  } else {
    ok(`${item.file}: ${WRAPPED.log.sql.length} statement(s) issued, identical`);
  }
  if (WRAPPED.log.errors.length) {
    fail(`${item.file}: ${WRAPPED.log.errors.length} exception(s) beneath the seam (the module may swallow these):`);
    for (const e of WRAPPED.log.errors) console.log(`         ${e.phase}: ${e.message}`);
  } else {
    ok(`${item.file}: zero exceptions beneath the seam`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 4 · statements behind handlers — verbatim copies, tied to the source ══');

for (const item of BATCH) {
  if (!item.statements) continue;
  const src = fs.readFileSync(path.join(HOME, item.file), 'utf8');
  delete require.cache[DB_SEAM_JS];
  const { seam } = require(DB_SEAM_JS);
  const wrapped = seam(db);

  for (const st of item.statements) {
    // Tie to source: the copy here must still be what the file runs.
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    if (!norm(src).includes(norm(st.sql))) {
      fail(`${item.file} · ${st.name}: this harness's copy no longer appears in the source — ` +
           'the statement changed and the comparison below would be stale');
      continue;
    }
    let params;
    try { params = st.params(db); } catch (e) { fail(`${item.file} · ${st.name}: params failed: ${e.message}`); continue; }

    let ra = null, rb = null, ea = null, eb = null;
    try { ra = db.prepare(st.sql)[st.method](...params); } catch (e) { ea = e; }
    try { rb = wrapped.prepare(st.sql)[st.method](...params); } catch (e) { eb = e; }

    if (ea) fail(`${item.file} · ${st.name}: RAW threw: ${ea.message}`);
    if (eb) fail(`${item.file} · ${st.name}: WRAPPED threw: ${eb.message}`);
    if (ea || eb) continue;

    const n = Array.isArray(ra) ? ra.length : (ra ? 1 : 0);
    if (JSON.stringify(ra) !== JSON.stringify(rb)) {
      fail(`${item.file} · ${st.name}: results differ`);
      console.log('         RAW     : ' + JSON.stringify(ra).slice(0, 250));
      console.log('         WRAPPED : ' + JSON.stringify(rb).slice(0, 250));
    } else {
      ok(`${item.file} · ${st.name}: identical (${n} row(s), params ${JSON.stringify(params)})`);
    }
    // Types, not just values: JSON would hide a number that became a string.
    const sig = (r) => (Array.isArray(r) ? r : [r]).filter(Boolean)
      .map(o => Object.keys(o).sort().map(k => `${k}:${o[k] === null ? 'null' : typeof o[k]}`).join(',')).join('|');
    if (sig(ra) !== sig(rb)) fail(`${item.file} · ${st.name}: column value types differ`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 5 · the write path, raw vs wrapped, on scratch databases ══');
console.log('   (the live connection is read-only and must stay that way, so each side');
console.log('    gets its own throwaway database built by the module\'s own DDL)');

const os = require('os');
let anyWrite = false;
for (const item of BATCH) {
  if (!item.writeCheck) continue;
  anyWrite = true;
  const wc = item.writeCheck;
  const made = [];
  try {
    const results = [];
    for (const identitySeam of [true, false]) {
      const file = path.join(os.tmpdir(), `seam-writecheck-${process.pid}-${identitySeam ? 'raw' : 'wrapped'}.db`);
      try { fs.unlinkSync(file); } catch (_) { /* fresh anyway */ }
      const scratch = new Database(file);
      made.push({ file, scratch });
      if (wc.schema) wc.schema(scratch);
      const loadedMod = loadModule(item.file, { identitySeam, into: scratch });
      if (loadedMod.threw) throw new Error(`load (identitySeam=${identitySeam}): ${loadedMod.threw.message}`);
      wc.run(loadedMod.mod);
      results.push({ rows: wc.dump(scratch), errors: loadedMod.log.errors });
    }
    const [rawR, wrapR] = results;
    if (wrapR.errors.length) {
      fail(`${item.file}: ${wrapR.errors.length} exception(s) beneath the seam on the write path`);
      for (const e of wrapR.errors) console.log(`         ${e.phase}: ${e.message}`);
    } else {
      ok(`${item.file}: write path raised nothing beneath the seam`);
    }
    if (JSON.stringify(rawR.rows) === JSON.stringify(wrapR.rows)) {
      ok(`${item.file}: ${wc.via} — ${rawR.rows.length} row(s) identical after the writes`);
    } else {
      fail(`${item.file}: rows differ after the write path`);
      console.log('         RAW     : ' + JSON.stringify(rawR.rows));
      console.log('         WRAPPED : ' + JSON.stringify(wrapR.rows));
    }
    if (!rawR.rows.length) fail(`${item.file}: the write check wrote nothing — it proves nothing`);
  } catch (e) {
    fail(`${item.file}: write check failed: ${e.message}`);
  } finally {
    for (const m of made) { try { m.scratch.close(); } catch (_) {} try { fs.unlinkSync(m.file); } catch (_) {} }
  }
}
if (!anyWrite) console.log('   (no module in this batch writes)');

// ════════════════════════════════════════════════════════════════════════════
console.log('\n══ 6 · declared NOT covered by this run ══');
let anyUnexercised = false;
for (const item of BATCH) {
  for (const note of (item.unexercised || [])) {
    anyUnexercised = true;
    console.log(`   !     ${item.file}: ${note}`);
  }
}
if (!anyUnexercised) console.log('   (nothing — every statement in the batch was exercised here)');

console.log('\n' + '═'.repeat(72));
if (FAILURES === 0) {
  console.log('RESULT: PASS — every module in the batch loaded, stayed inside the proven');
  console.log('        member set, and returned results identical to the raw path.');
  process.exit(0);
}
console.log(`RESULT: FAIL — ${FAILURES} check(s) failed.`);
process.exit(1);
