#!/usr/bin/env bash
# Deploy the deterministic per-variant SKU Meituan mapping (commit 4271cd0).
# Run from the repo root on your LOCAL machine. Requires SSH access to HK prod.
#
#   bash scripts/_deploy_meituan_sku.sh
#
# What it does:
#   1. Copies the 6 changed files to the HK production box.
#   2. Restarts roots-v2 (runs the DB migration + SKU backfill, loads route + UI).
#   3. Restarts meituan-sync (loads the per-spec push logic in lib/meituan-browser.js).
#   4. Verifies: columns exist, backfill ran, peach has SKUs, /verify flags the 2
#      SKU-less groups.
#   5. Re-enqueues Peach Yogurt (264 小=99, 265 中=3) so the daemon pushes the
#      corrected per-spec stock. Watch the daemon log for:
#        stock updated: ... [130g 小 (1-180)…] → 99
#        stock updated: ... [230g 大 (1-190)…] → 3
set -euo pipefail
HK=root@47.239.89.63
RD=/root/roots-v2

echo "1/5  copying files… (explicit per-file dest paths — scp into a dir uses basename only)"
scp -q database.js                      "$HK:$RD/database.js"
scp -q lib/meituan-browser.js           "$HK:$RD/lib/meituan-browser.js"
scp -q routes/meituan-admin.js          "$HK:$RD/routes/meituan-admin.js"
scp -q public/retail-admin.html         "$HK:$RD/public/retail-admin.html"
scp -q scripts/meituan-daemon.js        "$HK:$RD/scripts/meituan-daemon.js"
scp -q public/retail-admin/11-meituan.js "$HK:$RD/public/retail-admin/11-meituan.js"
# Remove orphans a previous buggy run dropped at the repo root (basename copies).
ssh "$HK" "cd $RD && rm -f meituan-browser.js meituan-admin.js retail-admin.html"

echo "2-3/5  restarting roots-v2 (migration+backfill) and meituan-sync…"
ssh "$HK" "cd $RD && pm2 restart roots-v2 && pm2 restart meituan-sync && sleep 4"

echo "4/5  verifying…"
ssh "$HK" "cd $RD && node -e '
const db=require(\"./database\");
const cols=db.prepare(\"PRAGMA table_info(meituan_product_map)\").all().map(c=>c.name);
console.log(\"meituan_sku column:\", cols.includes(\"meituan_sku\"));
const peach=db.prepare(\"SELECT product_id,meituan_sku FROM meituan_product_map WHERE product_id IN (264,265)\").all();
console.log(\"peach skus:\", JSON.stringify(peach));
const n=db.prepare(\"SELECT COUNT(*) n FROM meituan_product_map WHERE meituan_sku IS NOT NULL AND meituan_sku<>\x27\x27\").get().n;
console.log(\"mappings with a SKU:\", n);
'"

echo "5/5  re-enqueue Peach Yogurt (264, 265) on tianhe…"
ssh "$HK" "cd $RD && node -e '
const db=require(\"./database\");
for (const pid of [264,265]) {
  const m=db.prepare(\"SELECT * FROM meituan_product_map WHERE product_id=? AND store_code=\x27tianhe\x27\").get(pid);
  const stock=db.prepare(\"SELECT physical_qty q FROM retail_store_stock WHERE product_id=? AND store_id=?\").get(pid, m.retail_store_id);
  db.prepare(\"INSERT INTO meituan_sync_queue (retail_store_id,product_id,store_code,new_qty,status,meituan_name,created_at) VALUES (?,?,?,?,\x27pending\x27,?,CURRENT_TIMESTAMP)\").run(m.retail_store_id, pid, \"tianhe\", stock.q, m.meituan_name);
  console.log(\"enqueued\", pid, \"qty\", stock.q);
}
'"
echo
echo "Done. Watch the push:  ssh $HK 'pm2 logs meituan-sync --lines 40'"
echo "Then re-check in the admin Meituan tab: ✓ Verify mappings  (expect only Oatly Classic + Hummus Asli flagged)."
