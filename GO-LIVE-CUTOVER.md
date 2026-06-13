# Roots Mini-App Go-Live Runbook — replacing OUT1N

**The switch:** publish roots-v2 to the shared AppID `wxba58433954562887`. Release in
the WeChat console = instant, global cutover. Rollback = WeChat **版本回退** to the
current (OUT1N) online version — the OUT1N backend is untouched, so rollback fully
restores the old experience.

**Decided:** order history + open orders are NOT migrated (extract from the old
backend manually if ever needed). ICP is NOT required — backend is HK-hosted and the
only ICP-sensitive surface (web-view tracking) is now a native page.

---

## ✅ Already done (in code / deployed)
- [x] Native tracking page replaces the `<web-view>` — no 业务域名 / ICP dependency (main `6971705`)
- [x] OUT1N wallet/points **restore flow** built: wallet page `getPhoneNumber` → `POST /api/retail/phone` → `claimMigrationCredit`
- [x] Endpoint audit: every customer API call has a live handler (only `faq/feedback` is intentionally fire-and-forget)
- [x] Re-seed script verified idempotent (claimed rows never re-written)

---

## GO / NO-GO GATES — all must be GREEN before Release
Test every item on the **体验版 (experience version)**, not just DevTools.

1. **`getuserphonenumber` enabled + funded** on AppID `wxba58433954562887`.
   → #1 silent-failure risk. Without it, returning customers CANNOT restore wallet/points.
   → Test: log in with a test account that has no phone → wallet page → tap restore → number binds, balance/points appear.
2. **WeChat Pay works** on the new backend — real **¥0.01** order paid end-to-end (not dev mode).
3. **Server domains entered** (mp.weixin.qq.com → 开发管理 → 开发设置 → 服务器域名):
   - `request` 合法域名: `https://rootskitchenchina.com`
   - `downloadFile` 合法域名: `https://rootskitchenchina.com`  (brand fonts at /assets/fonts/)
   - `uploadFile` 合法域名: `https://rootskitchenchina.com`  (safety)
   - socket / 业务域名: none needed (web-view removed)
4. **Migration roster re-seeded on prod** with the final OUT1N export (see T-0 step 2).
5. **Main package < 2MB** — confirmed at the DevTools upload step.

---

## T-7 days — prep
- [ ] Freeze new mini-app features.
- [ ] Full regression on the experience version — this release ships EVERY accumulated
      "mini-app half pending publish" change at once, so test broadly.
- [ ] Confirm gate items 1, 2, 3, 5.
- [ ] Dry-run the re-seed on a COPY of prod `data/roots.db` (see commands below).

## T-1 day — submit for review
- [ ] DevTools → upload version → mp console → submit for review (审核 can take hours–1 day).
- [ ] Get it APPROVED and staged so you control the exact Release moment.

## T-0 — cutover (pick a LOW-traffic window, e.g. late night)
1. [ ] (Optional) brief maintenance notice / freeze OUT1N wallet activity to bound snapshot drift.
2. [ ] **Final OUT1N export → re-seed roster on prod:**
       ```bash
       # local: build the data file from the latest OUT1N "User funds" + "Users list" export
       node scripts/build_migration_roster.js --file "<Users list.xlsx>"
       #   (and rebuild migration_credits.json from the funds export — holds {uid,phone,name,balance,points})

       # ship PII files to server (NOT committed to git)
       scp migration_credits.json root@47.239.89.63:/root/roots-v2/migration_credits.json
       scp migration_roster.json  root@47.239.89.63:/root/roots-v2/migration_roster.json

       # on server: DRY-RUN first, eyeball the totals, then apply
       ssh root@47.239.89.63 "cd /root/roots-v2 && node scripts/seed_migration_credits.js --dry-run"
       ssh root@47.239.89.63 "cd /root/roots-v2 && node scripts/seed_migration_credits.js"
       ssh root@47.239.89.63 "cd /root/roots-v2 && node scripts/seed_migration_roster.js"   # suppresses signup voucher for returning customers

       # delete the PII files from the server when done
       ssh root@47.239.89.63 "cd /root/roots-v2 && rm -f migration_credits.json migration_roster.json"
       ```
       Re-seed is safe: claimed rows are never modified.
3. [ ] **Backend smoke test on prod:** login → browse → add to cart → ¥0.01 pay → test-account wallet restore.
4. [ ] **Release** — use 分阶段发布 (phased) if available: 10% → watch 30 min → 100%.
5. [ ] Watch server logs + pay callbacks for 30–60 min.

## T+24–48h — monitor
- [ ] Keep the OUT1N backend reachable (read-only) for any manual extraction.
- [ ] Keep one-click **版本回退** ready.
- [ ] Spot-check: returning customers' wallet/points restoring correctly; no error spikes.

---

## ROLLBACK (if anything bumps)
mp.weixin.qq.com → 版本管理 → **版本回退** to the previous (OUT1N) online version.
Instant. OUT1N backend was never touched, so the old app is fully restored.
