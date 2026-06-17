#!/usr/bin/env node
/**
 * Backfill DOUBLED-REGION addresses (saved address book + order snapshots).
 *
 * Companion to scripts/diagnose_doubled_address.js. The pre-fix bug let a
 * Chinese address keep its own province/city/district inside the freeform
 * street field, so `address_full` doubled (or tripled) the region:
 *
 *   北京市 北京市 海淀区 市 北京市 海淀区 西山国际2号楼   →   北京 北京市 海淀区 西山国际2号楼
 *
 * This cleans the structured columns in place. It handles the four real shapes
 * seen in prod data (see --selftest): doubled municipality fields, a leading
 * region prefix in the street, an orphan '市' + re-repeated region, and a region
 * block buried mid-street (often with a duplicated street chunk).
 *
 * SAFE BY DEFAULT — dry-run. It prints every before→after and writes NOTHING
 * until you pass --write. On --write it first dumps every affected row to a
 * timestamped JSON backup so the change is reversible. Re-running is a no-op
 * (idempotent: a cleaned row produces no further diff).
 *
 *   node scripts/backfill_doubled_address.js                 # dry-run, everything
 *   node scripts/backfill_doubled_address.js --selftest      # offline logic check, no DB
 *   node scripts/backfill_doubled_address.js --addresses     # dry-run, saved addresses only
 *   node scripts/backfill_doubled_address.js --orders        # dry-run, orders only
 *   node scripts/backfill_doubled_address.js --write         # APPLY (saved addrs + all orders)
 */
const path = require('path');

const argv = process.argv.slice(2);
const SELFTEST = argv.includes('--selftest');
const WRITE = argv.includes('--write');
// Scope: default both; --addresses / --orders narrow it.
const ONLY_ADDR = argv.includes('--addresses');
const ONLY_ORDERS = argv.includes('--orders');
const DO_ADDR = !ONLY_ORDERS;
const DO_ORDERS = !ONLY_ADDR;

// ── Cleaning logic (pure; unit-tested by --selftest) ──────────────────────
const MUNI_STEMS = ['北京', '上海', '天津', '重庆'];
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Collapse a municipality province written with 市 ('北京市') down to its bare
// stem ('北京'), matching how normalizeChinaAddress canonicalizes it. This is
// what de-doubles a province==city pair ('北京市 北京市 …').
function collapseProvince(province) {
  if (!province) return province;
  const stem = province.replace(/市$/u, '');
  return MUNI_STEMS.includes(stem) ? stem : province;
}

// Strip leading region tokens (and orphan admin chars / punctuation) from the
// front of the street, looped until stable so a re-repeated region peels fully.
function peelFront(street, variants) {
  let s = street.trim();
  let changed = true;
  while (changed) {
    changed = false;
    // a) a full region value at the head (longest-first). RESTART the scan on
    //    each strip so a freshly-exposed longer region ('北京市') is matched
    //    before a shorter one could partial-match and orphan a '市'.
    for (const v of variants) {
      const re = new RegExp('^\\s*' + escapeRe(v) + '\\s*', 'i');
      if (re.test(s)) { s = s.replace(re, ''); changed = true; break; }
    }
    if (changed) continue;
    // b) an orphan lone admin suffix char left dangling ('市 …', '区，…'),
    //    only when it's a SINGLE char followed by space/punct (not part of a
    //    real word like '海淀区').
    const orphan = s.match(/^\s*[省市区县][\s,，、]+/u);
    if (orphan) { s = s.slice(orphan[0].length); changed = true; continue; }
    // c) leading stray punctuation/space
    const punct = s.match(/^[\s,，、。.]+/u);
    if (punct) { s = s.slice(punct[0].length); changed = true; continue; }
  }
  return s.trim();
}

// Remove a region BLOCK that appears mid-street (province+city+district,
// city+district, province+city, lone city, lone province). Streets effectively
// never legitimately contain '广州市黄埔区' etc., so global removal is safe.
function removeMidBlocks(street, province, city, district) {
  let s = street;
  const combos = [
    [province, city, district],
    [city, district],
    [province, city],
    [city],
    [province],
  ];
  for (const parts of combos) {
    const seq = parts.filter(Boolean);
    if (!seq.length) continue;
    const re = new RegExp(seq.map(escapeRe).join('\\s*'), 'g');
    s = s.replace(re, '');
  }
  return s;
}

// Collapse an immediately-repeated chunk ('钟村街祈福新村钟村街祈福新村' →
// '钟村街祈福新村', '联和街道联和街道' → '联和街道'). Conservative: only exact
// adjacent repeats of length ≥ 3, a few passes.
function collapseAdjacentDup(street) {
  let s = street;
  for (let i = 0; i < 4; i++) {
    const next = s.replace(/([一-龥A-Za-z0-9]{3,}?)\1/g, '$1');
    if (next === s) break;
    s = next;
  }
  return s;
}

function tidy(s) {
  return s.replace(/\s{2,}/g, ' ').replace(/^[\s,，、。.]+|[\s,，、。.]+$/gu, '').trim();
}

// Returns { province, city, district, address } cleaned. detail is left as-is.
function cleanParts(province, city, district, address) {
  const p0 = (province || '').trim() || null;
  const c0 = (city || '').trim() || null;
  const d0 = (district || '').trim() || null;
  const province2 = collapseProvince(p0);

  let street = (address || '').trim();
  if (street) {
    // Variants to peel from the front: full administrative forms only. We drop
    // a bare municipality stem ('北京'/'上海'/…) — it's only 2 chars and would
    // false-strip a real street like '北京路'; the city value ('北京市') already
    // covers the duplicated region anyway.
    const variants = [...new Set([province2, p0, c0, d0].filter(Boolean))]
      .filter(v => !MUNI_STEMS.includes(v))
      .sort((a, b) => b.length - a.length);
    street = peelFront(street, variants);
    street = removeMidBlocks(street, province2, c0, d0);
    // The mid-block removal can leave a region freshly exposed at the head
    // (e.g. '北京市顺义区后沙峪…' after the leading copy was peeled) — peel again.
    street = peelFront(street, variants);
    street = collapseAdjacentDup(street);
    street = tidy(street);
  }
  return { province: province2, city: c0, district: d0, address: street };
}

function fullOf(p, c, d, a, det) {
  return [p, c, d, a, det].filter(Boolean).join(' ');
}

// A row needs writing iff cleaning changes province or address, AND the result
// is non-degenerate (street didn't get wiped to empty when it had content).
function planRow(province, city, district, address, detail) {
  const cleaned = cleanParts(province, city, district, address);
  const before = fullOf(province, city, district, address, detail);
  const after = fullOf(cleaned.province, cleaned.city, cleaned.district, cleaned.address, detail);
  const changed = (cleaned.province !== (province || null) || cleaned.address !== (address || '').trim());
  const wiped = !!(address && address.trim()) && !cleaned.address;
  return { cleaned, before, after, changed, wiped, skip: !changed || wiped };
}

// ── Self-test: reconstructed from the real prod diagnostic output ─────────
function selftest() {
  // [name, province, city, district, street, detail, expectFullAfter, expectSkip]
  const cases = [
    ['doubled muni, clean street',  '北京市', '北京市', '朝阳区', '三里屯街道工体北路三里屯外交公寓', null, '北京 北京市 朝阳区 三里屯街道工体北路三里屯外交公寓'],
    ['orphan 市 + re-repeat',       '北京市', '北京市', '海淀区', '市 北京市 海淀区 西山国际2号楼-2-414号', null, '北京 北京市 海淀区 西山国际2号楼-2-414号'],
    ['orphan 市 + region in tail',  '北京市', '北京市', '顺义区', '市 北京市 顺义区 北京市顺义区后沙峪镇名都园3338', null, '北京 北京市 顺义区 后沙峪镇名都园3338'],
    ['leading district',            '浙江省', '杭州市', '萧山区', '萧山区萧山科技城畅想路前湾国际中区9 幢1 单元602 室', null, '浙江省 杭州市 萧山区 萧山科技城畅想路前湾国际中区9 幢1 单元602 室'],
    ['mid block + dup 街道',        '广东省', '广州市', '黄埔区', '联和街道广州市黄埔区联和街道科翔路102号岭南山畔12栋2703房', null, '广东省 广州市 黄埔区 联和街道科翔路102号岭南山畔12栋2703房'],
    ['mid block + dup village',     '广东省', '广州市', '番禺区', '活力二期2栋3204 广州市番禺区钟村街祈福新村广州市番禺区钟村街祈福新村', null, '广东省 广州市 番禺区 活力二期2栋3204 钟村街祈福新村'],
    ['province+city mid',           '江苏省', '无锡市', '滨湖区', '太湖街道江苏省无锡市经开区富力十号c区3-2004', null, '江苏省 无锡市 滨湖区 太湖街道经开区富力十号c区3-2004'],
    ['orphan 市，punct',            '北京市', '北京市', '东城区', '市，东城区，吉安所北巷26号 进院右手边树边上的玻璃门', null, '北京 北京市 东城区 吉安所北巷26号 进院右手边树边上的玻璃门'],
    ['clean street, collapse prov', '上海市', '上海市', '长宁区', '虹桥路2279号 温莎花园60栋', null, '上海 上海市 长宁区 虹桥路2279号 温莎花园60栋'],
    ['mid city+district 深圳',      '广东省', '深圳市', '宝安区', '沙井街道深圳市宝安区沙井街道沙井社区万科三期一号楼1003A', null, '广东省 深圳市 宝安区 沙井街道沙井社区万科三期一号楼1003A'],
    ['order #228 leading region',   '北京', '北京市', '朝阳区', '市 北京市 朝阳区 麦子店街道朝阳公园西路17号', null, '北京 北京市 朝阳区 麦子店街道朝阳公园西路17号'],
    ['ALREADY CLEAN (no change)',   '北京', '北京市', '朝阳区', '麦子店街道朝阳公园西路17号', '天安·豪园A202房', '北京 北京市 朝阳区 麦子店街道朝阳公园西路17号 天安·豪园A202房', true],
    ['lone city mid 惠州',          '广东省', '惠州市', '惠阳区', '大亚湾霞涌街道惠州市大亚湾霞涌镇银滩花园5栋32层02号房', null, '广东省 惠州市 惠阳区 大亚湾霞涌街道大亚湾霞涌镇银滩花园5栋32层02号房'],
  ];
  let pass = 0, fail = 0;
  for (const [name, p, c, d, a, det, expectFull, expectSkip] of cases) {
    const r = planRow(p, c, d, a, det);
    const exactOk = r.after === expectFull && !r.wiped;
    const skipOk = (!!expectSkip) === r.skip;
    const noRepeat = !regionRepeats(r.cleaned.province, r.cleaned.city, r.cleaned.district, r.after);
    const good = exactOk && skipOk && noRepeat;
    console.log((good ? '  PASS ' : '  FAIL ') + name);
    console.log('       before: ' + r.before);
    console.log('       after : ' + r.after + (r.skip ? '   [skip]' : ''));
    if (!good) console.log('       expect: ' + expectFull + (expectSkip ? '   [skip]' : ''));
    if (good) pass++; else { fail++; }
  }
  console.log(`\nself-test: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

// Repeat detector by whitespace-token equality (NOT substring) so a clean
// '北京 北京市' is not falsely flagged.
function regionRepeats(province, city, district, full) {
  const toks = String(full).split(/\s+/);
  for (const v of [province, city, district].filter(Boolean)) {
    if (toks.filter(t => t === v).length >= 2) return v;
  }
  return false;
}

if (SELFTEST) { selftest(); }

// ── DB pass ───────────────────────────────────────────────────────────────
const Database = require('better-sqlite3');
const fs = require('fs');
const DB_PATH = path.join(__dirname, '..', 'data', 'roots.db');
const db = new Database(DB_PATH, { readonly: !WRITE });

const backup = { when: null, addresses: [], orders: [] };

function run() {
  const addrUpdates = [];
  const orderUpdates = [];

  if (DO_ADDR) {
    const rows = db.prepare(
      `SELECT id, customer_id, recipient_name, province, city, district, address, detail
         FROM retail_customer_addresses`
    ).all();
    for (const r of rows) {
      const plan = planRow(r.province, r.city, r.district, r.address, r.detail);
      if (plan.skip) continue;
      addrUpdates.push({ r, plan });
    }
  }

  if (DO_ORDERS) {
    const rows = db.prepare(
      `SELECT id, order_no, status, fulfillment_type, recipient_name, address_full, address_json
         FROM retail_orders
        WHERE COALESCE(fulfillment_type,'delivery') <> 'pickup'`
    ).all();
    for (const r of rows) {
      let j = {};
      try { j = JSON.parse(r.address_json || '{}'); } catch {}
      if (j.pickup) continue;
      if (!(j.address || j.province || j.city || j.district)) continue; // legacy full-only — skip
      const plan = planRow(j.province, j.city, j.district, j.address, j.detail);
      if (plan.skip) continue;
      orderUpdates.push({ r, j, plan });
    }
  }

  // ── Report ───────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(` BACKFILL DOUBLED-REGION ADDRESSES  ${WRITE ? '*** WRITE ***' : '(dry-run)'}`);
  console.log('══════════════════════════════════════════════════════════════');

  if (DO_ADDR) {
    console.log(`\nSaved addresses to clean: ${addrUpdates.length}`);
    for (const { r, plan } of addrUpdates) {
      console.log(`  addr #${r.id} cust #${r.customer_id} ${r.recipient_name || ''}`);
      console.log(`     before: ${plan.before}`);
      console.log(`     after : ${plan.after}`);
    }
  }
  if (DO_ORDERS) {
    console.log(`\nOrders to clean: ${orderUpdates.length}`);
    for (const { r, plan } of orderUpdates) {
      console.log(`  order #${r.id} ${r.order_no || ''} [${r.status}] ${r.recipient_name || ''}`);
      console.log(`     before: ${plan.before}`);
      console.log(`     after : ${plan.after}`);
    }
  }

  if (!WRITE) {
    console.log('\nDry-run — nothing written. Re-run with --write to apply.');
    return;
  }

  // ── Backup then write, in one transaction ──────────────────────────────
  for (const { r } of addrUpdates) backup.addresses.push({ ...r });
  for (const { r } of orderUpdates) backup.orders.push({ id: r.id, order_no: r.order_no, address_full: r.address_full, address_json: r.address_json });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  backup.when = stamp;
  const backupPath = path.join(__dirname, '..', 'data', `backup-doubled-address-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`\nBackup written: ${backupPath}`);

  const tx = db.transaction(() => {
    const updAddr = db.prepare(
      `UPDATE retail_customer_addresses
          SET province = ?, city = ?, district = ?, address = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    );
    for (const { r, plan } of addrUpdates) {
      updAddr.run(plan.cleaned.province, plan.cleaned.city, plan.cleaned.district, plan.cleaned.address, r.id);
    }
    const updOrder = db.prepare(
      `UPDATE retail_orders SET address_full = ?, address_json = ? WHERE id = ?`
    );
    for (const { r, j, plan } of orderUpdates) {
      const newJson = { ...j,
        province: plan.cleaned.province || null,
        city: plan.cleaned.city || null,
        district: plan.cleaned.district || null,
        address: plan.cleaned.address || '',
      };
      const fullAfter = fullOf(plan.cleaned.province, plan.cleaned.city, plan.cleaned.district, plan.cleaned.address, j.detail);
      updOrder.run(fullAfter, JSON.stringify(newJson), r.id);
    }
  });
  tx();
  console.log(`\nWROTE: ${addrUpdates.length} saved addresses, ${orderUpdates.length} orders.`);
  console.log('Restore if needed from the backup JSON above.');
}

run();
