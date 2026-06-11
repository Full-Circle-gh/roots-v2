#!/usr/bin/env node
/**
 * Build the OUT1N "returning customer" phone roster from the full members
 * export (Users list XLSX) — used to SUPPRESS the new-customer signup voucher
 * for anyone who was already an OUT1N customer.
 *
 * Rule (decided 2026-06-11): every row that HAS a phone number is an existing
 * OUT1N customer → must NOT receive the "new signup" voucher. Rows with no
 * phone can't be matched anyway and are treated as eligible new users.
 *
 * Output: migration_roster.json — an array of { phone, uid, name } with phones
 * normalized to bare digits. This is PII → it is NOT committed to git; scp it
 * to the server next to the repo root and seed with seed_migration_roster.js,
 * then delete it from the server.
 *
 * Usage (local, needs xlsx):
 *   node scripts/build_migration_roster.js --file "C:/path/Users list.xlsx"
 *   node scripts/build_migration_roster.js --file <xlsx> --out <roster.json>
 */
const path = require('path');
const fs   = require('fs');
const XLSX = require('xlsx');

function argval(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

// Same normalization as routes/retail.js + seed_migration_credits.js so the
// roster keys line up exactly with a getPhoneNumber result and the value seed.
function normalizeMigrationPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('86')) d = d.slice(2);
  return d;
}

const xlsxPath = argval('--file');
const outPath  = argval('--out') || path.join(__dirname, '..', 'migration_roster.json');
if (!xlsxPath) { console.error('[roster] --file <xlsx> is required'); process.exit(1); }
if (!fs.existsSync(xlsxPath)) { console.error(`[roster] file not found: ${xlsxPath}`); process.exit(1); }

const wb   = XLSX.readFile(xlsxPath);
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });
console.log(`[roster] read ${rows.length} rows from ${path.basename(xlsxPath)}`);

const seen = new Set();
const out = [];
let blank = 0, dup = 0;
for (const r of rows) {
  const phone = normalizeMigrationPhone(r.Phone ?? r.phone);
  if (!phone) { blank++; continue; }
  if (seen.has(phone)) { dup++; continue; }
  seen.add(phone);
  out.push({
    phone,
    uid:  r['User ID'] != null ? String(r['User ID']) : null,
    name: r.Name ? String(r.Name).slice(0, 100) : null,
  });
}

fs.writeFileSync(outPath, JSON.stringify(out, null, 0));
console.log('─'.repeat(50));
console.log('rows with phone   :', out.length);
console.log('rows blank phone  :', blank);
console.log('duplicate phones  :', dup);
console.log('written to        :', outPath);
console.log('\n[roster] NOTE: contains PII — do NOT commit. scp to server, seed, then delete.');
