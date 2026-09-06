#!/usr/bin/env node
/**
 * diagnose_deployed_tree.js — compare the DEPLOYED file tree against what the
 * repository says should be there, file by file.
 *
 * WHY THIS EXISTS
 * ---------------
 * Nothing in this project has ever compared the box against the repository.
 * deploy.yml computes what to ship as a diff against the PREVIOUS PUSH rather
 * than against what was last successfully deployed, so a run that fails before
 * its ship step never ships its files, and the next push diffs against that
 * failed commit and skips them too — permanently, while every later deploy
 * reports SUCCESS. The signal is inverted: the deploy that drops your change is
 * the one that says it worked.
 *
 * A replay of all 904 deploy runs found 197 stranding episodes across 141
 * distinct files; 71 ran longer than a week and the worst ran 43 days. But a
 * replay of CI logs is not a measurement of the box — it cannot see a manual
 * edit on the server, or a ship made by the local post-commit hook. This script
 * is the measurement.
 *
 * WHAT IT DOES
 * ------------
 * For every file the deploy allowlist covers, it hashes the copy on the server
 * with git's own blob hash (sha1 of "blob <len>\0" + bytes) and compares it to
 * the hash recorded in the generated block at the foot of this file. Same hash
 * means the deployed bytes ARE the committed bytes. The comparison is valid
 * because the deploy scp's the runner's checked-out bytes verbatim: on Linux
 * every deployable file's working-tree bytes equal its blob content, checked
 * explicitly against this repo's .gitattributes (`* text=auto` plus several
 * `-text` pins).
 *
 * The manifest is embedded rather than read from the checkout because
 * ro-query.yml stages only lib/, routes/ and middleware/ onto the box — the rest
 * of the repository is not there to compare against. MANIFEST_COMMIT records
 * which commit it was generated from, so a stale manifest declares itself.
 *
 * READ-ONLY
 * ---------
 * fs.readFileSync and fs.readdirSync, nothing else. It opens no database, binds
 * no port, writes no file and restarts nothing. There is no code path in here
 * that mutates the server.
 *
 * FOUR ANSWERS, NOT ONE
 * ---------------------
 *   DIFFERS    the file is on the box but its bytes are not the committed bytes.
 *              This is the drift the diff-base bug produces, and the only thing
 *              here that is a defect.
 *   MISSING    the repository has it and the box does not — a file that never
 *              reached production at all.
 *   REWRITTEN  the installer rewrites it AFTER installing it, so it can never
 *              match its committed bytes. Reported in full, with both hashes,
 *              and never counted as drift. See INSTALLER_REWRITTEN below.
 *   EXTRA      the box has a deployable-looking file the repository does not.
 *              A SEPARATE and un-fixed channel: deploy.yml skips deletions
 *              (`[ -f "$f" ] || continue`) and deploy-apply.sh only ever copies,
 *              so a file deleted from main stays live forever. Not every EXTRA is
 *              drift — public/ also holds uploads and scripts/_*.json is
 *              gitignored — so EXTRA is reported and never fails the run.
 *
 * Exit 0 only when DIFFERS and MISSING are both empty. REWRITTEN and EXTRA are
 * shown but do not fail: a check that is permanently red is a check people learn
 * to ignore, and then it stops catching the thing it exists for.
 *
 * Run: node scripts/diagnose_deployed_tree.js
 *      (or via .github/workflows/ro-query.yml, which is how it reaches the box)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// The live application. ROOTS_APP exists so this can be pointed at a copy; the
// default is the only path that answers the question actually being asked.
const APP = process.env.ROOTS_APP || '/root/roots-v2';

// The allowlist deploy.yml and scripts/deploy-changed.sh both use, verbatim, so
// this measures exactly the set the deploy claims to manage. A file outside it
// is not drift — it was never deployable.
const DIRS = ['public', 'routes', 'lib', 'middleware', 'scripts'];
const FILES = ['server.js', 'database.js', 'schema.sql', 'package.json', 'package-lock.json'];

// public/sw.js can never match its committed bytes: deploy-apply.sh rewrites the
// CACHE constant in place at install time to stamp the service-worker version.
// Comparing it raw would report a permanent false difference on every run, so
// both sides get the stamp neutralised and are compared normalised — which still
// catches a real change to sw.js and forgives only the stamp.
// Files the installer rewrites AFTER installing them. They cannot match their
// committed bytes on the box, so counting them as drift would leave this check
// permanently red — and a permanently red check is one people stop reading.
// Kept VISIBLE rather than excluded: silenced is not the same as gone, and
// someone should still be able to see that the deployed lockfile is not the
// committed one. This list is the same pair deploy.yml's post-ship verification
// sets aside, and the two must stay in step.
const INSTALLER_REWRITTEN = {
  // deploy-apply.sh stamps the service-worker CACHE constant at install time.
  // Neutralising the stamp on both sides makes a real comparison possible, so
  // this one is still compared properly and still counts as a match or a miss.
  'public/sw.js': 'CACHE stamp rewritten by deploy-apply.sh — compared with the stamp neutralised',
  // npm install --omit=dev rewrites the lockfile in place whenever package.json
  // or package-lock.json ships. There is no normalisation that recovers the
  // committed bytes, so this one is reported and never judged.
  'package-lock.json': 'rewritten in place by npm install --omit=dev — cannot be compared',
};

const SW = 'public/sw.js';
const SW_STAMP_RE = /(const CACHE = 'roots-v2-shell)[^']*(';)/;

// This file cannot measure itself. Its own hash changes every time the manifest
// below is regenerated, so an entry for it would be stale the moment it is
// written — the manifest would have to contain the hash of a file that contains
// that hash. Excluded from BOTH sides rather than left to surface as a false
// DIFFERS or a misleading EXTRA. A measurement tool that cannot measure itself
// should say so rather than report a number it knows is wrong.
const SELF = 'scripts/diagnose_deployed_tree.js';

// Files that are on the box, are NOT in the repository, and are meant to be.
// Counted and named separately from EXTRA so a scheduled report does not open
// with a known-ignorable entry — a report whose first line is always noise is a
// report people learn to close. Each needs a reason, and the reason has to be
// about why it is deliberately untracked, not merely why it exists.
const EXPECTED_EXTRA = {
  'scripts/zero_yuexiu_stock.js':
    'one-off operator script, untracked ON PURPOSE — a committed scripts/ file '
    + 'ships and bounces pm2. Pre-change snapshot at /root/stock-snapshots/.',
};

let FAILURES = 0;
const fail = (m) => { FAILURES++; console.log('   FAIL  ' + m); };
const ok = (m) => console.log('   ok    ' + m);

function blobSha(buf) {
  return crypto.createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf]))
    .digest('hex');
}

function walk(rel, out) {
  let entries;
  try { entries = fs.readdirSync(path.join(APP, rel), { withFileTypes: true }); }
  catch (e) { return; }                       // an absent directory surfaces as MISSING
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    // Never descend into a nested dependency tree, and never follow symlinks:
    // isDirectory()/isFile() on a Dirent do not resolve links, so the symlinked
    // node_modules ro-query creates is neither walked nor hashed.
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(child, out); }
    else if (e.isFile()) out.push(child);
  }
}

function main() {
  console.log('deployed-tree comparison');
  console.log('   app      : ' + APP);
  console.log('   manifest : ' + MANIFEST_COMMIT + ` (${Object.keys(MANIFEST).length} files)`);

  if (!fs.existsSync(APP)) {
    console.error('FATAL: ' + APP + ' does not exist — this is not the live box.');
    process.exit(2);
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n══ 1 · hash every deployable file on the box ══');

  const onBox = [];
  for (const d of DIRS) walk(d, onBox);
  for (const f of FILES) { if (fs.existsSync(path.join(APP, f))) onBox.push(f); }
  onBox.sort();
  console.log(`   ${onBox.length} deployable file(s) found under ${APP}`);
  const selfIdx = onBox.indexOf(SELF);
  if (selfIdx !== -1) { onBox.splice(selfIdx, 1); console.log(`   (excluding ${SELF} — see SELF above)`); }

  const boxHash = new Map();
  const unreadable = new Set();
  for (const rel of onBox) {
    try {
      let buf = fs.readFileSync(path.join(APP, rel));
      if (rel === SW) buf = Buffer.from(buf.toString('utf8').replace(SW_STAMP_RE, "$1<STAMP>$2"));
      boxHash.set(rel, blobSha(buf));
    } catch (e) {
      unreadable.add(rel);
      console.log(`         unreadable: ${rel}: ${e.code || e.message}`);
    }
  }
  if (unreadable.size) fail(`${unreadable.size} file(s) could not be read — the comparison is incomplete`);
  else ok(`all ${boxHash.size} readable`);

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n══ 2 · deployed bytes vs committed bytes ══');

  const differs = [], missing = [], extra = [], rewritten = [];
  for (const rel of Object.keys(MANIFEST).sort()) {
    const want = rel === SW ? MANIFEST_SW_NORMALIZED : MANIFEST[rel];
    const got = boxHash.get(rel);
    if (got === undefined) { if (!unreadable.has(rel)) missing.push(rel); }
    else if (got !== want) {
      // A mismatch on a file the installer rewrites is expected, not drift.
      // It is still surfaced in full, with both hashes, in section 3.
      (rel in INSTALLER_REWRITTEN ? rewritten : differs).push({ rel, want, got });
    } else if (rel in INSTALLER_REWRITTEN) {
      rewritten.push({ rel, want, got, matched: true });
    }
  }
  const expectedExtra = [];
  for (const rel of onBox) {
    if (rel in MANIFEST) continue;
    (rel in EXPECTED_EXTRA ? expectedExtra : extra).push(rel);
  }

  // Only a rewritten file that actually MISmatched goes unjudged. One that
  // matches was compared like any other and counts as a match.
  const unjudged = rewritten.filter((r) => !r.matched).length;
  const judged = Object.keys(MANIFEST).length - unjudged;
  if (differs.length === 0) {
    ok(`all ${judged} judged file(s) match the repository byte for byte`);
  } else {
    fail(`${differs.length} file(s) DIFFER — production is not running what main says:`);
    for (const d of differs) {
      console.log(`         ${d.rel}`);
      console.log(`            main: ${d.want}`);
      console.log(`            box : ${d.got}`);
    }
  }

  if (missing.length === 0) {
    ok('no file in the repository is absent from the box');
  } else {
    fail(`${missing.length} file(s) are in the repository but NOT on the box:`);
    for (const m of missing) console.log('         ' + m);
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n══ 3 · files the installer rewrites after installing them ══');
  console.log('   Shown, never failed — these cannot match their committed bytes, so');
  console.log('   judging them would leave this check permanently red. Visible, not hidden:');
  console.log('   the deployed lockfile really is not the committed one, and that is worth');
  console.log('   being able to see. Same pair deploy.yml sets aside post-ship.');
  for (const rel of Object.keys(INSTALLER_REWRITTEN)) {
    const r = rewritten.find((x) => x.rel === rel);
    console.log(`   ${rel} — ${INSTALLER_REWRITTEN[rel]}`);
    if (!r) {
      console.log('      not in this comparison (absent from the manifest or from the box)');
    } else if (r.matched) {
      // sw.js matching means the stamp normalisation worked. package-lock.json
      // matching means npm has not rewritten it on this tree — worth saying
      // plainly rather than implying a normalisation that does not exist for it.
      console.log(`      matches ${rel === SW ? 'once normalised' : '— not rewritten on this tree'}: ${r.got}`);
    } else {
      console.log(`      main: ${r.want}`);
      console.log(`      box : ${r.got}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n══ 4 · files on the box the repository does not have ══');
  console.log('   Reported, never failed — deletions are a separate un-fixed channel, and');
  console.log('   public/ uploads plus gitignored scripts/_*.json land here legitimately.');
  if (extra.length === 0) {
    ok('none');
  } else {
    console.log(`   ${extra.length} extra file(s):`);
    for (const e of extra) console.log('         ' + e);
  }
  if (expectedExtra.length) {
    console.log(`   plus ${expectedExtra.length} deliberately untracked, not counted as extra:`);
    for (const e of expectedExtra) console.log(`         ${e} — ${EXPECTED_EXTRA[e]}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(72));
  console.log(`summary: ${judged - differs.length - missing.length} match, ` +
              `${differs.length} differ, ${missing.length} missing, ` +
              `${unjudged} installer-rewritten, ${extra.length} extra`);
  if (FAILURES === 0) {
    console.log('RESULT: PASS — the deployed tree is the repository at ' + MANIFEST_COMMIT.slice(0, 10) +
                (unjudged ? ', apart from the installer-rewritten file(s) above.' : '.'));
    process.exit(0);
  }
  console.log(`RESULT: FAIL — ${FAILURES} check(s) failed.`);
  process.exit(1);
}

// ════════════════════════════════════════════════════════════════════════════
// GENERATED BLOCK — git blob hashes of every deployable file at MANIFEST_COMMIT.
// Regenerate against a newer commit with:
//
//   for f in $(git ls-tree -r --name-only HEAD | grep -E '^(public|routes|lib|middleware|scripts)/|^(server\.js|database\.js|schema\.sql|package(-lock)?\.json)$'); do
//     [ "$f" = scripts/diagnose_deployed_tree.js ] && continue   # SELF — see above
//     printf '  "%s": %s,\n' "$f" "'$(git rev-parse HEAD:"$f")'"
//   done
//
// SELF is excluded, so the manifest is identical for MANIFEST_COMMIT and for the
// commit that regenerates it — this file is the only thing that changes between
// the two. That is what keeps the regeneration from chasing its own tail.
//
// MANIFEST_SW_NORMALIZED is public/sw.js hashed with its CACHE stamp replaced by
// the literal <STAMP>, matching what SW_STAMP_RE does to the deployed copy.
//
// Since 2026-08-27 the committed CACHE value is a fixed sentinel
// (`roots-v2-shell-unstamped`) rather than a hand-edited version, and the deploy
// appends sw.js to every ship so the installer always stamps it. Two
// consequences for this manifest: the RAW entry for public/sw.js below now moves
// only when sw.js's actual code changes — it no longer churns once per UI
// commit — and a box reading `roots-v2-shell-unstamped` has not been stamped at
// all, which is a deploy fault rather than a normalisation problem.
// ════════════════════════════════════════════════════════════════════════════
// Generated 2026-08-27 from origin/main = 8891397b. main carries 614 deployable
// files and 613 are below — SELF is the one deliberately left out.
//
// The loop above is the readable recipe, but `git ls-tree -r` already carries
// every blob hash, so one pass rebuilds the whole manifest without spawning a
// process per file:
//
//   git ls-tree -r origin/main | awk '
//     { p = $4 }
//     p == "scripts/diagnose_deployed_tree.js" { next }
//     p ~ /^(public|routes|lib|middleware|scripts)\// ||
//     p ~ /^(server\.js|database\.js|schema\.sql|package\.json|package-lock\.json)$/ {
//       printf "  \"%s\": %c%s%c,\n", p, 39, $3, 39
//     }'
//
// MANIFEST_SW_NORMALIZED is the one value git cannot hand over ready-made:
// public/sw.js has to be re-hashed AFTER SW_STAMP_RE swaps its CACHE stamp for
// the literal <STAMP> — the same substitution section 1 makes to the deployed
// copy — so feed `git show origin/main:public/sw.js` through that replacement
// and blob-hash the result. The raw committed hash stays in MANIFEST below.
//
// THIS MANIFEST ANSWERS FOR ONE COMMIT, and the next push moves the answer. A
// deploy that lands after this was generated ships files whose committed bytes
// have moved on, and this tool reports every one of them as DIFFERS — correctly
// by its own definition, uselessly by yours. So read the summary against
// MANIFEST_COMMIT, not against "now": a handful of DIFFERS that are exactly the
// files the last push touched is the baseline being behind, not the box being
// wrong. Regenerate whenever that handful starts costing more attention than it
// saves — and treat a DIFFERS the last push did NOT touch as the real thing.
const MANIFEST_COMMIT = '24b67f1c68df901474a6a656aba7eccd1747c2a6';
const MANIFEST_SW_NORMALIZED = 'accc481a97211bd819376e621428a7232578f82f';
const MANIFEST = {
  "database.js": '647e72640fb53102ee2fb40a3e0f016deee2c224',
  "lib/address-cn.js": '12d738c662f7583d63ceaa8b00380c7cfab99696',
  "lib/address-pin.js": 'ae110a22c6caac8cc9f9e60d77eccfd2ed2c1d4b',
  "lib/alert-latch.js": 'c12951ffdcac60d34045a76203d2e690f6233c0b',
  "lib/alipay-ocr.js": 'b7b7d7850c695f7c532b8ebc7099061863a7a112',
  "lib/aliyun-sms.js": '7c9474cc935270d0f819e827c6d870b12c6d23ac',
  "lib/app-home.js": '63ea1b93d4924c36744f2568db0ed724c7bb77f9',
  "lib/billing-lifecycle.js": '92378adf6e6cd660e069955b7191e0b7e47420bb',
  "lib/billing-providers.js": 'bab3caee8775b0d0a6a2e7882c47d6f4584d1251',
  "lib/brand-designer.js": '40b35994bf85d2f16c695fc058c472e18a6ed216',
  "lib/brand-fonts.js": '46af474c365d7b2a1dd427b08f4e9621f134ac56',
  "lib/brand-gates.js": '7943ee5c57e29bfab4219295f7ad58e4ca08c8e7',
  "lib/brand-theme.js": 'f78b6784728245afa4145f08f5ec6d98299e2651',
  "lib/brand-tokens.js": '0362e829cd17ee5114cb4362f1b254e5329cd4ce',
  "lib/browser-env.js": '2c8aa644a011f6ec03e85e8c9bdf61ba521357d9',
  "lib/browser-warmup.js": '75c1fc987f976fc300b5f3a5b258dda367f19bee',
  "lib/bundle-cost.js": '84a2c2e22269681c6ccd6beebeb850d0ff9deac8',
  "lib/bundle-stock.js": '97939012a6ee254771584ffe0bc9f3b137d151a0',
  "lib/business-date.js": 'e794f6afe098edd3351dbf4ff4da1f6bb6cb5e1f',
  "lib/cap-routes.js": 'a96162b7ab59f9216a2fd1f84ccd85b1b87e9062',
  "lib/capabilities.js": '34687ffcb1c05b2b038981b3f96ac7144ce9a029',
  "lib/category-text.js": '3ad57afb0c91409da16c250893fbaed96bd5db8c',
  "lib/category-tree.js": '30d054811b35b3d6ae4f0a7e12433c42cd00b28f',
  "lib/channel-drift-sweep.js": '194f873ce04efbd98d5839e0099810c00eb484e1',
  "lib/channel-settlement.js": '618629b1711b2161d3a136b0aaeffa72b7dc6bfd',
  "lib/channel-sync-stale.js": 'c542ae412a71906ef37de819fad53d99fa05c0bc',
  "lib/china_districts.json": '3d129d1b1e70b1811e9d2682f4be0f0869f82e79',
  "lib/db-seam.js": '7a8f90960ce8249f51b0c5012ff418c863bcadd2',
  "lib/db-transaction.js": '82645f30208b3dc91f6a4303c1890f7f6920a6cf',
  "lib/delivery-reminders.js": 'c18177b8a86c60c55acc98e12698e51e8f890fa2',
  "lib/eleme-browser.js": '6d929bd8565436aeace69776bb5e5b394a1993c7',
  "lib/eleme-client.js": '5d45527fda8cf831129f5d13efce12c83eab829f',
  "lib/eleme-sync.js": 'cf2e51de91d10ee54ceeef8e461f72a24d8c6636',
  "lib/email-sender.js": 'eafa2f04f212c7a7f8d32ee527540cac4a5ae282',
  "lib/express-async-guard.js": 'd4b120aca139eced6ce969702b7401224bffe463',
  "lib/features.js": 'bb82894b25dbeb5ee04ee29deb6c9bb758871307',
  "lib/feie.js": 'a261c945858bf381f2632c6a0e6717fcb8fe4348',
  "lib/finance-window.js": 'd5a90b113f07832704893455c5295ff506b26f7d',
  "lib/flashsales.js": '2a89a02327382f774730235d70f8f3ab1ade1abf',
  "lib/fulfilment.js": '9559061c04b3620b84fbbb4b19a4606583807a98',
  "lib/geocode.js": '89bf292d83cdac7bf1cd56eaf93a886c622c4e7f',
  "lib/guanyi-browser.js": 'fd85a2e53dac41e3f4a82f128f103a8118583ef0',
  "lib/guanyi-sync.js": '79c503570184aebb24c5f9f8a569d4103ae8aabe',
  "lib/gzgrocery-admin.js": '566f7de87e163ecb79f49ac063f8712b27cf4b9c',
  "lib/gzgrocery-order-notify.js": 'f733f692cff72c4328e026da9da3e7e63ff2a93d',
  "lib/image-dims.js": '3a9e6ff7a5b731ac7abbf15316594b1e6dcda036',
  "lib/ingredient-cost.js": '9139f88b2ffa6c18522db77204ec3e50606e93f0',
  "lib/integrations/registry.js": 'ce25d65979977b127fbee780c118d56bb078a061',
  "lib/integrations/session-relay.js": '7267c7e4e8109a82a766d4ffe8df0fc24a3798ab',
  "lib/inventory.js": '688bd761ac8255eec8652a160b944e69d219b1b8',
  "lib/invoice-mark.js": '7c35bf9280cfa4deeee80ab96795b7e96d540087',
  "lib/jd.js": 'acae7c38322e828a2611ccc98c2de1a4d6a54382',
  "lib/kitchen-adds.js": 'e60631ea2990148fb2566a9d99a1c32b32e678f4',
  "lib/kitchen-print.js": '50b1f8b74cdf63092a27deef0b87041cb66a9062',
  "lib/list-window.js": '96a04394a6c3a7fe1c7dc8cc6bb4fb6998581ab3',
  "lib/load-env.js": '5c6d2a39b96f4a1a1eab694a15396964ffe89a43',
  "lib/locale-defaults.js": 'cf95e6dde8b99ce3450f37f573521849fc84ba94',
  "lib/low-stock-digest.js": '55df971af907b88cbabcdceaf3108382f416d6e4',
  "lib/meituan-browser.js": 'ea9e3114f65118a524ce202a66cb49ad1409952b',
  "lib/meituan-bundles.js": 'f2f799e28755e59f6f0b08f905bc62aa616691f0',
  "lib/meituan-drift-sweep.js": '25e719e186d07f4e613729f1029d4bd582a89f62',
  "lib/meituan-map-write.js": 'cbe02c1619bcda15f962538021f23e7ef1d45ded',
  "lib/meituan-order-fields.js": 'c82b2f675729ba84d57f57a7d690d8d78fbf8d87',
  "lib/meituan-queue-stall.js": '0e8d62f1b34baf0672865b0f772986a62f57cd97',
  "lib/model-gateway.js": '678242662b442e80aa6af5dd3a409cd80d76a7b8',
  "lib/money-columns.js": '0452595047c81a770c96eb88b877fce52d48e955',
  "lib/money.js": '666d4e280aa3259cd1e56db6030415ea4961b01b',
  "lib/notify-log.js": '7c8f4a7cddf2c32a9f7f5068e40e88fd1331836c',
  "lib/nuonuo.js": 'c32140cf60d1c9135f890e5e92c25a6c7e816961',
  "lib/nutrition-rows.js": 'ee72d3537764d3e7de5597a249f0330ca78e5617',
  "lib/onboarding-steps.js": 'd24c09394a759d1a30ad8119ffdd7ef27452b0d5',
  "lib/operator-caps.js": '053ec7e844056a71783b94ec0227989baf224c5e',
  "lib/ops-alert.js": '791475ff5c1c84db9440cd22f70c18aeabf487ca',
  "lib/pack-units.js": 'c3e630754a182af5af59d2b421a9b72c80465b31',
  "lib/phone-cn.js": 'aaa9a429173472a4adf524567320cad81ace5673',
  "lib/platform-admin.js": '0420ad762a7b2f45db71825fe9339807fd14a75a',
  "lib/platform-alert.js": 'f04e48790ada5f04632137fa99b1d1027725c218',
  "lib/po-number.js": '8119d1e1e176363f51f50b75924eb43a114ee0a7',
  "lib/po-rematch.js": 'e3468d653e1236fcfec7afdd689bc7f491139a28',
  "lib/po-returns.js": '0430b33df4db48efe59886ffd5620112fe425b76',
  "lib/po-supersede.js": '73595722661a2b945818b66ebe88846091618d64',
  "lib/product-blocks-read.js": '8a5532622312c43765add48d58d1f3d458da2c89',
  "lib/product-build-cost.js": '084bd45d53e269a6db423d24f92d9250e452d1f1',
  "lib/product-cost-visibility.js": 'fa3523c3ff290e97f374476a2fed52025d09a863',
  "lib/product-cost.js": '1d60a04d89e9419c5aa1700a285f2e3d25047597',
  "lib/provision-tenant.js": '11ceaf58133a7e5fd55dbc4136f0dcc4b327c20d',
  "lib/proxy-manager.js": '00018c482004bcaa54129e44b17385f6e71ec657',
  "lib/push-events.js": '980d00f6a2ec40fab7c1a09740d219f41c642449',
  "lib/qingyun-browser.js": '577985a000619033139a2860170e2ca71c5879be',
  "lib/qingyun-payload.js": '88c6e7d001422b802db3fc4e4e1c2ef9c682858e',
  "lib/qingyun-queue.js": '6e6fb34b83da73a996c7b6dad5a737b61860996d',
  "lib/qrpng.js": 'b2302c664a88eaeea9b1e597d80160f3b5bceb78',
  "lib/quick-stock-grant.js": '7b3c32fd0c4f4216dba37f8c72b441ffdc90bae2',
  "lib/recipe-cost-data-write.js": '170618a78b631593024b15c6fc9d75010fe72945',
  "lib/recipe-cost.js": '21d9528c0e663d12a500e163936b2e6cabfada88',
  "lib/recipe-graph.js": '0e155eb3d1f5d2d555308e4e147c6009963e83ea',
  "lib/recipe-materialize.js": '3606f02a3451294330ceb57140483a2ac4077743',
  "lib/recipe-rollup.js": '55df67d9c8c10b7bacab69d43f29234b1bca93c9',
  "lib/recipe-versions.js": '2e82049bc971bec3dd05c2f70c6ef486bfc16a6c',
  "lib/recipe-yield.js": '4f5e8af8b1ceba5177afbda74af0e2305f27bc69',
  "lib/recycle.js": '31a469c0e24da078b20422d0448f7472462aa1c0',
  "lib/region-i18n.js": 'e6bad1453ac523f3b988af0e7de8244d7bb4414f',
  "lib/require-cap.js": '6b4ef9bd5630da3e31ac2abdcd0819895fd7683e',
  "lib/review-seeder.js": '65d95e5b6d1e6d325b073187481ab71056ad8c7f',
  "lib/review-topup.js": 'e98748f85b6e236a29afe0b9b44dc5d04768fb08',
  "lib/roles.js": '62c4ec3579fdca4e1e5b80903e3ded506f1f0466',
  "lib/secret-box.js": '6dd2d764b215ada290d380c09eea2dbb6c9666e8',
  "lib/shangou-browser.js": '866affcfa18c1245793ead20a022d98c234ed452',
  "lib/shop-code.js": '67a0d782be103a9c7a43e571674758fef619e6af',
  "lib/shop-order-code.js": '8cffb624e785dd00158b952c39e5dbd4a599522b',
  "lib/shop-qr.js": 'afd7a1ead7e00d87d83efd28eed86577d945186a',
  "lib/sku-format.js": '2a691f95bb7e5bea5714e78ee0ee28e85451de82',
  "lib/sku-rules.js": 'ecf673467bc6c14a45397bda9d4a2862abbc029c',
  "lib/slot-label.js": '32c008f09ca0b75dfb5bc0b5c97c6ea2dae1f72e',
  "lib/social-auth.js": '092b434a5411bc1ebff6c1f0474184feb4205cb0',
  "lib/static-assets.js": '29e898705bb550343dfdf42766706c5b15dfaf7a',
  "lib/stock-app-only.js": '25344fb7338199b916f7716b96d6170a9bb8187d',
  "lib/store-close.js": '3e7e691b635d75414701755aefdaedd9d81fd4b0',
  "lib/store-hours.js": '715c9f5801096479be86a020435a61dc7f7b007a',
  "lib/store-trading.js": '1168b04bf73115271e724744ba6573603a9e4188',
  "lib/tax.js": 'b8d638436f19d0d6f9ead4fd46398e379bf91f1f',
  "lib/tenant-creds.js": '749e548a6a66ad416c5eee4a827797bb3e50eb26',
  "lib/tenant-db.js": '7e5f63f8fc3c8dd2cc093874c7a321bbba255d99',
  "lib/tenant-notify.js": 'f4a933208c5ca7aa609aa414c2228f54f614646f',
  "lib/tracking.js": '65983befb407c9c55b103ac9ff3cb3bbd2daf409',
  "lib/waste-record.js": '8e55aec927161267e41b4564daf43a70ed3ab2a7',
  "lib/wechat-oa.js": 'e2ee5a1a8e4207c6396f388912a44339f4243baf',
  "lib/wx-sec-check.js": '1042f7ea8cefc9355d41753a9f192dac6ee83159',
  "lib/wxacode-knockout.js": 'c4929904330dcd098ac174def199635d9857c990',
  "middleware/auth.js": '130384678e5fa2a565631fa14e93790d6c74b770',
  "middleware/block-kitchen-cost-writes.js": '770ab7c331d3146b96b46b890f77a7b620912859',
  "middleware/public-tenant.js": 'b93126509f30ddf8b1ab4c10a829938b09bffffd',
  "package-lock.json": '83d0d2c859ba0258d04c6dfcb3bceebd4c44865d',
  "package.json": '69309eb1f975402ed437cb56c816fe9aca189b2b',
  "public/app.html": '763080c18ca38153fa7fb219f62e7add3397d285',
  "public/app.html.bak": '5991891f0060f97c4660f4d25b26a422d6845b9e',
  "public/apple-touch-icon.png": '52f0d35477978e0bcccf81dff1a2fa4237ca97ae',
  "public/assets/cms-mobile-mockup.html": '19ba9d62bca2d093ae79afcb386310444e7cdd6b',
  "public/backend-account.html": 'a1c08369842d3ba6ef2d4817e372437fd5cc2d49',
  "public/backend-billing.html": '6980b270350651491dae614c3f23a955e3933bb8',
  "public/backend-brand.html": 'c85eb98fa6bd4b1d913d019dcb34ad0a47ef47f8',
  "public/backend-login.html": '1f71522a6da10aaf509a343eff0f5b3567b32a3b',
  "public/backend-signup.html": 'f89c7f27307432fcab88193c426aee05d1da11fb',
  "public/brand-studio.html": '703fcb17db07786dfa08ec2d866e85383838f385',
  "public/brand/ip-broccoli.jpg": '07725a737fbf9941dc2f69c9ba97a41f75471fb8',
  "public/brand/ip-flex.jpg": 'dc5677f0972715198b08a018ea6a109eb3f21aae',
  "public/brand/ip-hula.jpg": 'b1726f91abe20555f1b6e607217e9ad587d9c88e',
  "public/brand/ip-kombucha-gang.jpg": '067bc05d0dddc6c81453ca3a9e09a3e665967b46',
  "public/brand/ip-mushroom.jpg": '020409bc07ee3dfa3eab5f5669eec94949e0cc01',
  "public/brand/ip-onion.jpg": '7c1c621ef10db8c4fd30c4e1349b7c9aa13c6562',
  "public/brand/ip-onion.png": '0c11388c69528d89c34baba5b582ec4960323314',
  "public/brand/ip-peas.jpg": 'eb02d7da41bf51c7ad2cd4f839a5d57fa67226bb',
  "public/brand/ip-radishes.jpg": '5358051dfbb0415bb1c7d897be00cde5977834cf',
  "public/brand/ip-skater.jpg": '850d48c68bb82f9ce74b8c1596a8142d543a98ca',
  "public/brand/ip-soilsoul.jpg": '381c7c5bb644fcf31241b5b273e0c8819db6eab6',
  "public/brand/mascot-flex-ink.png": '900c8599688a6c93414d6a58dfd2e217532b5d21',
  "public/brand/welcome-roots.jpg": 'feaddd7481620440d08eaa66d5a9bf45c395c086',
  "public/cms-mobile-mockup.html": '46bef25ec17835bfdb973877e804a95b0ca5604a',
  "public/cms-mobile-v2.html": '37fc1377e7ce55cb329e65cd6ece027b3ed17f35',
  "public/cms-mobile.html": 'beb1e2e384f3576a0ee40b88645ca0e945fd032b',
  "public/cms.html": '6b3c11310c5a60b63d56a0d273286fc9dee51bc4',
  "public/editor.html": '7592c2cd34d6cd8fb30717670d6f019b2adee06a',
  "public/favicon-32.png": 'f20f13f7bb1c5b7739c80675bf4284fdce0dbbc0',
  "public/favicon.ico": 'b5150e5fad306955ec7d0452a5e87d4ca1902452',
  "public/favicon.svg": 'a4198466f3c614bb20433a55706c20bca08ba71f',
  "public/fonts/Aleo-Regular.otf": '2e2a0750a85e35b76e33842e965425c5c25ea1f1',
  "public/fonts/BearSerif.otf": '7f0f4fc96d13d662468090fc2d993810bd9962b3',
  "public/fonts/DFYuanW5.ttf": 'cca24b5b0367ef954766dc21bff4635d47b78550',
  "public/fonts/DFYuanW7.ttf": '92d69842191b5e95054bb41c1d7fa6ee85bebedb',
  "public/fonts/DFYuanW9.ttf": '3d4776f27647bfa2205f5a22cf887de7ac0470e8',
  "public/fonts/LeagueGothic.ttf": 'c6ca354c0e914a90791b7cf100a60bfb9bad1c13',
  "public/fonts/LilitaOne.ttf": '895cac8f28af699f11e29f304a4042a884724278',
  "public/fonts/ToniGroteskPro.otf": '92c3e557f183231c72ba29e273707485f9420400',
  "public/full-circle.html": 'fdd8f2f7f825b44e696a86d477feafa1d3f72cc4',
  "public/kitchen-icon-192-maskable.png": 'e7582d66e5a660bddc249e9c0d72ae733a3284ee',
  "public/kitchen-icon-192.png": '2bdd3571374c1a09fd53cc962990fc84480df5ae',
  "public/kitchen-icon-512-maskable.png": '0be6d998ee4f66f9725ef3778eb8549be492acde',
  "public/kitchen-icon-512.png": 'd75e466acb9abb2cf0cae6297b04c9eca2cd6155',
  "public/kitchen-manifest.webmanifest": '14730d4ecbb233e21159ed4f70efa284c72affb8',
  "public/kitchen.html": 'f447808fd2ac3e610d135b6505424ee3b9904635',
  "public/login.html": '5cd46e9cc5a747c4717ff2a3f4f76364a6b5e308',
  "public/m-manifest.webmanifest": '691b8e9e95058170e0bc305bc1b0194136f8296b',
  "public/m.html": '28026b22960cb71b340facab04ce48c287ac38d6',
  "public/manifest.webmanifest": '0f6513b9b45220bc3f4d6dcf7e240ef98ea5c9e0',
  "public/pos-icon-192-maskable.png": '8176b34f04d6338f0df79779241a15997e0c0a90',
  "public/pos-icon-192.png": '0a85c313e45e17625a93a8a01fae2143b01db519',
  "public/pos-icon-512-maskable.png": 'ae387246724320b6beb29c967b2658a860b35b25',
  "public/pos-icon-512.png": 'b35d4dca359687b19b11f81caaf0a7992f0f4ea2',
  "public/product-editor.html": '5090167056adfd2e4555294ec7944fe3c79c3f28',
  "public/retail-admin.css": 'd0b0b7a64ddbcc9eb29a4d09ab1ae6f1881c8f35',
  "public/retail-admin.html": '4ec6b2a68d11538195ff4ce6fde5136146b491fd',
  "public/retail-admin/01-core.js": 'fe48dde6f7b322770a87a70f69566c08359a02ac',
  "public/retail-admin/02-settings-ops.js": 'e939d302ef7057e0b05735127170a03ae2c796d4',
  "public/retail-admin/03-dashboard.js": '0d2c2b09e4757e92c803fa4d19f2fe1351ece495',
  "public/retail-admin/04-orders.js": '63106b88ea09d4d3acc7a7d557c997d08d4076d0',
  "public/retail-admin/05-marketing.js": 'c7ca3dfa86191a89de7c2bd8e1a53e6a274bcf32',
  "public/retail-admin/06-delivery.js": '833c6386b82e6bb36bb87318fa27655772b1dc05',
  "public/retail-admin/07-content-billing.js": 'c8e9ec79f7abf32ac6657ba0f4d4f7683812e3ad',
  "public/retail-admin/08-customers.js": '486a4930c74fc72cdd1e2400de06e5f2656aa0fc',
  "public/retail-admin/09-products.js": '15df9e903131875268b4be05e1144b3b977e5029',
  "public/retail-admin/10-extras.js": '55b3f807df9db348f2f23a8dfe54adb259009c08',
  "public/retail-admin/11-meituan.js": 'ceca8555a9376862348dbde668d6fd6cd7b52cd7',
  "public/retail-admin/12-guanyi.js": '636e9cedbda0fc4ca8070f087e89b8b82842b066',
  "public/retail-admin/13-activity.js": '646cbb83fa704297d70bac2bc66a1875c6ecca43',
  "public/retail-admin/14-eleme.js": '9f63b0453298e1bba110622621b23c67dd475fcc',
  "public/retail-admin/15-integrations.js": '1570c5e1cad82168715a00e4a2dfff03d56bc9b7',
  "public/retail-admin/16-purchasing.js": 'ed8fa5b70d21224a6f056199933aabae79aba574',
  "public/retail-admin/17-setup-guide.js": 'b924180a2a76c1505c06fa7703bd570b8ed58a41',
  "public/retail-admin/18-materials.js": '63c3ca311704b024616ad5975dfd52077523d55b',
  "public/retail-admin/19-recipes.js": '1c9f83c93910b7147dae20a007fd8f3533a1ca05',
  "public/retail-admin/20-waste.js": '6469e8b1f45f2f7008b130b28b443d2f546796fe',
  "public/retail-admin/21-product-build.js": '3ecf1812876736c27d9e946898db2745c1f0c058',
  "public/retail-admin/22-finance.js": '382313a29b6ca6f48ed29151259ac66cbd2b8608',
  "public/retail-admin/23-sku.js": 'c77d4e3960f8f12acf4d6597cf4c049ae4232acd',
  "public/retail-admin/24-import.js": '81dc7188fc085089823af0fed692a7bf6d651b4b',
  "public/retail-admin/25-views.js": 'b7f3980378751db264c7d4e68259b72c3b92373c',
  "public/retail-admin/26-print.js": '6709a115927d93b8fcd58943e3e583d0299832a3',
  "public/retail-admin/27-keyboard.js": 'a8b4480648c45c3edc9b8c55a402c1a41f69febd',
  "public/retail-admin/28-shops.js": '946d0062f3116b010a16c96d18d5c2c06d505938',
  "public/saas-admin.html": 'f619eecf363eb3524bf1e771b3b5988258387e8c',
  "public/shop.html": '569379ea4592a089f03150ca93b0976a67013652',
  "public/shop/_gallery.fixtures.js": 'cf8a878460a769d6560c21d156d6b133520e33ee',
  "public/shop/_gallery.html": 'ad653d21f3366dc7e93b70df60f9c404947d5658',
  "public/shop/_gallery_frame.html": 'e829fd800a08b74621f1c9fc900843da6f8d4095',
  "public/shop/_mockups.html": 'b32c9b2d5f3877849e61c03c41525624eb708375',
  "public/shop/blocks.css": 'fcb6f046704a6b39d9d50a8fdd3e58f99c1c8963',
  "public/shop/blocks.js": 'd9d10033fbcdf5b7a51a989f517ee0a6b7797286',
  "public/shop/product-blocks.css": '94ffbd20e5e088db1dc7e7eb20db1cb573d669ce',
  "public/shop/product-blocks.js": 'ed2aaf42ba3621a3de663a544c5046e5022bcd0c',
  "public/stock-icon.svg": '0a60278f12f5989be772b50f3548f485fc35831c',
  "public/stock-manifest.webmanifest": '2dd64879e772a3fcc733854f278db34713c87d70',
  "public/stock.html": '3437831299ac28ccacdb9c99d963ac834292ac0b',
  "public/store-admin.html": '57b7b2302e4298823bfc4a8890c23e28621b3613',
  "public/storefront.html": '6fd767d7cf498ca89b63c735fb249c364bd4ec9c',
  "public/sw.js": '236240c745c51da81f1cdfda316d1813face6fb2',
  "public/tacet-apple-touch-icon.png": '1fff42cfdc247739a7baf3f4f57502df6b25ee40',
  "public/tacet-dialogs.js": '75f978c56b0b01f2cdca2e9884f2a26c1327c07e',
  "public/tacet-favicon.svg": '960020f8858f89edb0505b00e4e020445c960718',
  "public/tacet-icon-192-maskable.png": 'daad0f8f21d609bd8442856a8ad73b84136dd707',
  "public/tacet-icon-192.png": '6d983dc12c415e248ba6d40cd0591030a2131f38',
  "public/tacet-icon-512-maskable.png": 'bcd5ac4a05a69c4b8f5878accdbbd5c07c175888',
  "public/tacet-icon-512.png": '47319bc8e6411f1e8debfcd118a0c6b2ba0b4898',
  "public/tacet-icon.svg": 'e8c108f849588b02bf67d6e33534ff410a453ee1',
  "public/td-datetime.js": '4fcef4526dc639eace5ceb15a890af970394d43c',
  "public/till-manifest.webmanifest": 'e613d95a6043bf104c384fd06e7243f0ba688b98',
  "public/till.html": '93765737c383ea492c220d4a9525fe32143ba082',
  "routes/admin.js": '935c7c3c6638cea53a947e3f2d84aa02d8e24ad2',
  "routes/ai.js": 'f480a0e3c497eba40132cba77298919ac5fe3d11',
  "routes/alerts.js": '6d629f3fd7a2a3a3fc483c8bd6636491da548898',
  "routes/auth.js": '3d520280b079019869074c60504fafc657773f8f',
  "routes/backend-auth.js": '82c7d7f833c8ea0f43c621a9f1631abf823a4aea',
  "routes/backend-notices.js": '886b45a327fd5225db31ddb38731fd111773deca',
  "routes/backend-signup.js": 'efed41ad9eeb161caecbb8e5e41843a1ad084f77',
  "routes/backend-team.js": 'a9e2196fd18034f531ae17e26015233af598ab1d',
  "routes/billing-pay.js": '07674172e275953f1586ccace5448f312327cd71',
  "routes/billing.js": 'd10d79f9ccae1340bb529cb9d95253e86760f1ec',
  "routes/eleme-admin.js": '696c123b2f7889569a0c22e1335d8afd395fc6b3',
  "routes/eleme-internal.js": 'cbcf887c340ed2e97f9e716c1a8b8a18fc4ac448',
  "routes/events.js": '193a1b0f6560c21770a1ddf0d693afd3dd7aee9b',
  "routes/feedback.js": '4abf3f9a71436778ce1fa35ddfd666c5cf676483',
  "routes/finance-summary.js": '965302e2250d98253f1505b8300dbaef6ff10d31',
  "routes/finance-transactions.js": '8c4a7a817edece7605f10099dc895d912998b837',
  "routes/finance.js": '9d868b5c8ee43902cdb5cce46bd024979a5ab136',
  "routes/guanyi-admin.js": '119544ac210903f3d83dc3c3f1919dfdc93ed9a5',
  "routes/ingredients.js": '4d516fa24e36f278edbd17733ac0dfd06d7d9828',
  "routes/integrations-admin.js": '2eccf66d12e7a22528ec0b505ef18d364ba872f6',
  "routes/kitchen.js": 'e2d2668485950babbb23986bb2768645c6b3f8df',
  "routes/lookups.js": '4fff8f65c9ae38e704e44415bb8224985e893771',
  "routes/markets.js": '69f8e7bfd2f90b8d15d866d31f9cb5ae2ff27488',
  "routes/meituan-admin.js": 'f921ffde2cefcabff4a198601bbef610a1a9fd70',
  "routes/meituan-internal.js": '313c26438c440a8d10045a9d5878bc40e3600828',
  "routes/pos.js": '5144e41f33dc53042cfddd203c7ab68b59957687',
  "routes/production.js": '6059b6a3ada9d6fa16c9c2e710f49b9463e57a38',
  "routes/products.js": '00bd30d822a6ed5a885dde25b5a6ec12d3920039',
  "routes/purchases.js": '7d0ed4baffaddc801c2678a30dc3fda09d53b862',
  "routes/push.js": 'ed7fb6fd1df3d24b46e0ccc1c51116b636da0d2b',
  "routes/recipes.js": 'c79b4afef3077f6b7797a073c2ecd06d9cdb6946',
  "routes/recycle.js": '023a5fbc09b73abd24bfec9bcb7ee7411b777e40',
  "routes/restock.js": '8c233dcff7ee4ebb93e663e9ebaa9826fba1c06a',
  "routes/retail-inventory.js": '5d09457002670c36da41b8bac164de1ef93f0a53',
  "routes/retail-materials.js": '7667aed0ca384f97c4e01c27bdffae7b142a4453',
  "routes/retail-page-templates.js": 'bd8782806bf36a3b86aff74e91ea9654cc3b9161',
  "routes/retail-product-build.js": 'ef5f458ad0325bb879b06a0d66a64fc513ac06cb',
  "routes/retail-production.js": '2ef95f665022916481758c41b615df85af28197d',
  "routes/retail-purchasing.js": '02df48ee9ec2d9748f6382f803c0d026b8cb4bad',
  "routes/retail-recipes.js": '9fe63ce2760b1b7723099e8f890ce7ea6741f759',
  "routes/retail-setup.js": 'a4c48e135e71f97f4afac6e51c77a06a6d5d400a',
  "routes/retail-shops.js": 'bc160b2ceb249845a06a7825561e2d88c8cfeb05',
  "routes/retail-waste.js": '669eb3b6770c3b424fde6f6637c9aafd9e3fab02',
  "routes/retail.js": 'd18c028c82791b739f572090df87034adbef40aa',
  "routes/saas-admin.js": '13791ad822df0fe616d451a948c3b2e8448ca290',
  "routes/sales.js": 'b6faef77ef43b9fd16ad40dbfb7cf4cb45b7263d',
  "routes/saved-views.js": '50bdcbdfaee7730b6ab1b30b53737b2f9ae86ea6',
  "routes/shop-menu.js": 'd8869811a0767807baf18da16860aaca2256c995',
  "routes/sku.js": '0ecbcaac025b67c9ba3c10b505092f48a45fe739',
  "routes/store-admin.js": 'a8b548c8ddc089061be7712dba2c380bf663a268',
  "routes/waste.js": 'd7ebce86fef55c6955e34b425409c2560a6d9bd5',
  "schema.sql": '6098116f924592205ad951a1ae6b489442d657f6',
  "scripts/_apply_yogurt_mappings.js": '4f82eac34eda0811857ef0c3cbde3d19c83d4e0b',
  "scripts/_dump_blockless_groups.js": '7105e8086735d2f478097668fc30af0d52938555',
  "scripts/_gallery_serve.js": 'de63da34e9e82b21360a6f2be055c6161578f8c1',
  "scripts/_guanyi_pricing.json": '073d643123518a612407aadbe23acd650784880b',
  "scripts/_repush_paced.js": '6cf426f1617e65e9ef6f8d5411c52bac3d7fd4d2',
  "scripts/_sorbet_build.js": 'e85caec3c29816e87c2b5e697fd103c3f1356148',
  "scripts/add_harissa_extra.js": '69150e56c0e43ca4c9a01e1e0c8e3248ac30a307',
  "scripts/add_shipping_zones.js": '26327205edab01dcae54b2afa666be66726f8e54',
  "scripts/add_shipping_zones_batch2.js": 'bfc1f96e5faa433ffb308a78c996e8bf67538df9',
  "scripts/add_shipping_zones_batch3.js": '5a570dff67ca75a7a1a2de46fbb678a87c12eee9',
  "scripts/add_shipping_zones_batch4.js": 'b3c1865841bbc878d9d6198c2127343cc5af2b47',
  "scripts/addon_mapping.json": '4fa4a67c7ac4a0370ceac402d29887ad150e5379',
  "scripts/apply_compliance.js": '89d1bdb32428a0115d2720990a60a28d4ed24a42',
  "scripts/apply_home_brand_colors.js": '3ecd8d5e6874dedde539e5d5d0d893052b09003a',
  "scripts/apply_name_suggestions.js": '716c7f9c3170578d29aadbffc2e0ed941f4e8ba0',
  "scripts/audit_about_borrowed.js": '3c9008c9342249c0d9c89304633cea348fc354b3',
  "scripts/audit_made_materials.js": 'b15d76c28d6d56496f577385822398dbd0bab068',
  "scripts/auto-push.sh": '3081691e656977c5d286356fa40617f57ee4fc6f',
  "scripts/backfill_addon_payments.js": 'fb4110285e2053a5866e31ef41bdec6824388468',
  "scripts/backfill_addons.js": 'ba897570e5333682c98219427707edbc38c58867',
  "scripts/backfill_doubled_address.js": '51de8ef88798d0670f39a4acdaddfe9496df4dfd',
  "scripts/backfill_image_aspect.js": '4cfed69f9e97017998d1f0995bb79592646498ab',
  "scripts/backfill_materialize_recipes.js": '60e5a8cb93ceacc63ea087b2247630f00a4edd04',
  "scripts/backfill_order_tracking_mirror.js": '333275d5e370b0decd498259d222941d787e0647',
  "scripts/backfill_refund_requested_to_paid.js": '39952500dd5bed11ecf9e96c7152ca5926721cfd',
  "scripts/backfill_shipment_tracking.js": '9f354d83b84cd02063a9f9488f2a6677fc92dbb6',
  "scripts/backfill_supplier_tenant.js": '5e3c6727c5734342f8d1ed350cdaaa54bedff21e',
  "scripts/backfill_till_cap.js": '35204368f38bdd92d61b143c2cbf5bfa1356a7da',
  "scripts/backfill_weight_from_spec_strip.js": 'e5a244c2698654c1208a900ce5cdd6139b7fe344',
  "scripts/build-regions-dataset.js": 'a2fb8dbacacf1453d8efa74da39d8c1c9ccd7735',
  "scripts/build_gallery_fixtures.js": 'f11c902d22a53f1aa1e56efe3cde2c256e288ea3',
  "scripts/build_migration_roster.js": '74cfcd17c299ab38748a3d0551d845f164dcdda5',
  "scripts/catalog_text_dump.json": 'a9e6bd28acaedbd53d5cd02067a2102cd951b96b',
  "scripts/categorize_items.js": 'cadb1904125cb7bd16bc629cb6c0e917b2107199',
  "scripts/check-alert-audience.js": '53296704364f3fb8369b6c5342fb972c8597aace',
  "scripts/check-default-passwords.sh": 'cc18739a243774e9bc967f5a7542113aedae27a4',
  "scripts/check-html-js.js": '91c62df445b136fb62166f1720f153aec6966d4c',
  "scripts/check-i18n-banners.js": '5a76513a77aab1b708b0aa41760d1076fcc89fee',
  "scripts/check-swallowed-errors.js": '90894bc1f7c1bad92ff749e6d0d159d67af7de02',
  "scripts/check-td-datetime.js": 'c1d7507f2c5871bf78c0db2dc7e387be24cc41b2',
  "scripts/check-tenant-als.js": 'ca68bb41ba4b679b5ee2986e96496dca794b2dfb',
  "scripts/check_ledger_invariants.js": 'a63668ea909cc8c80c9169c5a0cf6c370a2e2553',
  "scripts/check_money_invariants.js": 'eeca32af678d57fda3e1dcf5b2bbb74acd2be0d1',
  "scripts/check_points_invariants.js": 'd70cfe78e2c0a8edf29328938baab0c9cf2703b1',
  "scripts/check_review_categories.js": '7115ee8e2c720e8c71bad974b2c1ef992dd2daae',
  "scripts/check_shop_listing_names.js": '7e041afe11442c374f706f50b81b02cfc0514d02',
  "scripts/check_sync_freshness.js": '030e353debbe0d2d0aced8671e8c797ddf996de4',
  "scripts/clear_stuck_refund_R260618156719.js": 'f4e3bf0fb97b25c59c154581640a32bbca19d9cc',
  "scripts/collapse_zones_into_default.js": '95141695ffc2261a968eed51190ad9282cb96a3d',
  "scripts/compliance_edits.json": 'a3411473eae31950e7c9e485048961e11c03ce73',
  "scripts/consolidate_guangdong_and_hk.js": 'e5fc692235bd9986fffb66cea7dac77e5abecc08',
  "scripts/convert_gzgrocery_xlsx.js": '9bf58f03996098001ba006adc187d7486f202033',
  "scripts/convert_meituan_xlsx.py": '4bb104a2410413c085dab474f0e286bde219e576',
  "scripts/copy_hummus_extras.js": '269a54f08b28b3a7e2776a29f026a3fed42b8536',
  "scripts/copy_soup_options.js": '0c109115abd8aac1cdb5390d5b522e3af3bbfd36',
  "scripts/db-backup.sh": '152a46d9eb046a60db522f53473d1b2ecd182fae',
  "scripts/db-seam-coverage.js": 'a3ce3265fe58bb83793b06c431cced61837733d3',
  "scripts/dedupe_province_covered_cities.js": '2a15ea6a400d9a7d2b98f89ad8f53e505535c55a',
  "scripts/deploy-apply.sh": '9ad67616793a2f932c1be6d497a76848d18bca5a',
  "scripts/deploy-changed.sh": 'da441ab8fa3f9c559e3b4a3ace3e9bad8241f182',
  "scripts/diagnose_addon_stock_misses.js": '1ff3f1e3fd84a160270528c7cbd2e11853e16186',
  "scripts/diagnose_address_pins.js": 'b28f208cd0409a380019179069531bc2323c3dea',
  "scripts/diagnose_affiliate_figures.js": 'ac6097f240505385211238ba392ce6aaef1218a0',
  "scripts/diagnose_arrived_prefill.js": '4c66ecd02e3f1e11231242baef54edcc67b67fa2',
  "scripts/diagnose_channel_money_columns.js": '1de32684646d317e4825012d3a3ec4e052c1d0db',
  "scripts/diagnose_channel_money_gaps.js": '52f99fc6cf4cadc07a3963a8a0a9769daec2bf28',
  "scripts/diagnose_channel_queue.js": 'a324bd9ef69a8398027d8737a3c235ea143c75fd',
  "scripts/diagnose_channel_settlement.js": '4305019414c401f99844edf71e8b5bf4171cbb0b',
  "scripts/diagnose_doubled_address.js": 'f09e82dc0b5e7134dd8ff2ef2ef57791251663d6',
  "scripts/diagnose_eleme_courier_status.js": '2062acbcd9698fddc5b49343e00c6447a5a094d6',
  "scripts/diagnose_eleme_order_money.js": '3d068913590b04089ede418b0ca09457aa029bbc',
  "scripts/diagnose_eleme_payload_shape.js": 'c66b915236ab84822d95c1e7956bca7a337a8ee0',
  "scripts/diagnose_eleme_phantom_orders.js": 'fd5df83af6dcb578290c87cf117bf7e519333bf3',
  "scripts/diagnose_eleme_stage_replay.js": '3409a8a280c2cbcd887a76f1d7460886220c3940',
  "scripts/diagnose_eleme_status_now.js": '49604a2d2001fca119495f3a343a161f7aa3428a',
  "scripts/diagnose_eleme_status_survey.js": 'db364a75b4df47f3a33ebc54ef0d8f9f7189cce7',
  "scripts/diagnose_fallback_store.js": '6917e9f319e5537151c05028242f105ae4c5f734',
  "scripts/diagnose_free_by_design_conflict.js": 'aa2baae948afac4618b4abd65725c35830e6138e',
  "scripts/diagnose_guanyi_errors.js": 'a2e9a26d6f44926662626731ba755dd75aa97d4f',
  "scripts/diagnose_gzgrocery_stock.js": '125ffab5f9d136678701cc272c225ffe6f655832',
  "scripts/diagnose_invoice_off_chase.js": '17c9e2601a11626c49cc2681049ee48c189fd615',
  "scripts/diagnose_made_material_readiness.js": '3d79dd9585607f9bb112b8de0c819a4c7eb49f56',
  "scripts/diagnose_migrations_ledger.js": '5580d5f0e4badd0957b5388d3b8ca8846b6d36d1',
  "scripts/diagnose_money_precision.js": '4b8c816cea76030ca352fbd8fdcdcf0c192cbf72',
  "scripts/diagnose_money_unit_mixing.py": 'dd89177db12b74bd3365cfc17d7afc0b48c038ac',
  "scripts/diagnose_money_unit_split.js": '98e3142159747c24be58dc123b63cf21020c98d5',
  "scripts/diagnose_phantom_order_refs.js": '02969247c2d8779cd61a1553457723304a86eb43',
  "scripts/diagnose_phase1b_live.js": 'c91c85185ca122666630f3c3def085295fdc3308',
  "scripts/diagnose_po_cost_rollback.js": 'e61c9db26f05f860761f0eaedb2db7a68fa1c872',
  "scripts/diagnose_po_duplicates.js": 'c3728087d54486cdce398b7cd54a459a8162304a',
  "scripts/diagnose_product_refs.js": '33abf7b0c75be1746e78e08bf04c0adf6c1d5615',
  "scripts/diagnose_proxy_state.js": '47b474733181cce8fcdbdc34599aba63eeb3c521',
  "scripts/diagnose_recipe_cost_live.js": '3fcefd8f5f93bdf18d035b963cc6276ef69608dd',
  "scripts/diagnose_recipe_cost_parity.js": 'e2f183b51eb5e056dcbdd8259ef7097f89c38448',
  "scripts/diagnose_recipe_unit_mismatch.js": '5c4ff5064e4d9df5c4214bb81da0b7aaa4775ae2',
  "scripts/diagnose_recipe_volumes.js": 'b3e35fc048def52285647e496764f66289ce9f40',
  "scripts/diagnose_refund_ceiling.js": 'bc0835bcd2613062ca70a536910ad73f4593af5e',
  "scripts/diagnose_seam_batch.js": '0ffd64fbd1401b7b0aa58716214b1f2856d3a593',
  "scripts/diagnose_seam_capability.js": 'f119bd6c0fb911b0df8ff93fe55e58fee8a195cd',
  "scripts/diagnose_seam_mechanism.js": 'c37b178a8f8c5aee0d873d47db1cb969bb42b56a',
  "scripts/diagnose_seam_statements.js": 'd931dbf55b984fb051112a16e50b003d5f6e138c',
  "scripts/diagnose_shipdistrict_orders.js": '437b09d73e37ae6ec6f756b1583a38561fa828b5',
  "scripts/diagnose_statement_sweep.js": '536951ee5b2f67b9522e3af1b4f5a9798c97c854',
  "scripts/diagnose_stock_queue.js": 'c6662dd42bb127afd5e0028f91bf87996f41e7c0',
  "scripts/diagnose_stock_shortage.js": '366a2b6958f8d816829d97936584fe1412b96575',
  "scripts/diagnose_store_hours_seam.js": '8afee8135b9a0382b834969fa5933b2ed36ce31c',
  "scripts/diagnose_tenant_step_a.js": '07a14911562ed156bc3be2fd7e2a78645af304a3',
  "scripts/diagnose_tenant_step_b.js": '73e8b216a47759086c4b32149821bbb3e0e87680',
  "scripts/diagnose_text_options.js": '1dd49a0111b6e43ed3f05612b78fb9f281fee1b1',
  "scripts/diagnose_variant_descriptions.js": '595919b9ae938f45089234645967f0899e81a130',
  "scripts/diagnose_waste_cost_parity.js": '7c98e0f27191ce07acd9ab1dacc3a16823131045',
  "scripts/dump_catalog_text.js": '5011a574fa870750ef2fd40a4dd7309ced2eb17f',
  "scripts/eleme-apply-reviewed-matches.js": 'c0e3d704301eaddce9bf04894cdd6bb68cb2224f',
  "scripts/eleme-daemon.js": '9d278dd0dab56087fd5c0e868d96587ae2e990da',
  "scripts/eleme-login.js": '365539d2e3c9524908ed511c1bf2906248d713e1',
  "scripts/eleme-match-products.js": '36cd7b1cb85e96184acac262311b53ba4eb640be',
  "scripts/export_kitchen_ledger.js": '9d9b7b5ec96f3477ea2058cf6640f676fd9894ea',
  "scripts/extract_retail_css.js": 'fa7dab6ca9fc47f65ce6c4fe62e099565afe9095',
  "scripts/extract_retail_js.js": 'ff1f1d03d00515f246d9ccb8e5ae3de2952cec52',
  "scripts/fix_default_zone_lead.js": '41ce06a276d701e8e5ed72ee33ac4598867ab7e2',
  "scripts/fix_duplicated_product_names.js": '7d16c20fd8751cf422535ca4e306641758bf61c0',
  "scripts/fix_eleme_order_money.js": '2877586970b14eebeb50c9056cc0d65eaab4cbd3',
  "scripts/fix_gz_district_lead.js": '7bd0d05d2a63b7ad6dbade3a3f7ed3f0e3b6b694',
  "scripts/fix_gz_district_sameday.js": 'bfbbbb156e225c4a31dd41df01f5c35d5d1d3573',
  "scripts/fix_outside_gz_slot_profile.js": 'c66edd5f2c43539937f0ed8f96f823db3fce435f',
  "scripts/fix_partial_shipment_clobber.js": 'a2ea3027beee31ee91518f84ff64fc6715f9ad53',
  "scripts/fix_products_swap.js": 'e9163e56c5cd06c2675f108beaf29bc484f964fb',
  "scripts/fix_shipdistrict_orders.js": 'd2550485bd0a45f4f53bf4bf7f2258f9762097b5',
  "scripts/fix_variant_block_design.js": 'a7603ccd5f744315e8a94a787264967829176949',
  "scripts/flash_pc_01_front.png": '4796d6a14ba202b6c4b841c18e99c24a434335c6',
  "scripts/flash_pc_02_ideas.png": '1271e9e54522ff7c62ddb117fe4654f0d7b3ba67',
  "scripts/flash_pc_03_pick.png": '5849abc03c3af8a6340d58a010b5fd866afe0e33',
  "scripts/flash_pc_04_discount.png": '22239e2e01af46e027237deda66b2fe3e0b99ff6',
  "scripts/flash_pc_05_when.png": 'd392762a41ad7542283a29e586066cd628bf3699',
  "scripts/flash_pc_06_review.png": '4d04bfeed5c77c27fca06d1011abc9127b702022',
  "scripts/flash_pc_07_headsup.png": 'b9d25112b718ba195f060626f55e70d24cbdefd3',
  "scripts/flash_pc_08_customer.png": '16fe84926767c32c0451964c2d2561bb19644e0c',
  "scripts/flash_pc_manifest.json": '581e5208fab3d3c88de667c2dfef452306cf2986',
  "scripts/flash_ph_01_front.png": '1aa4be1a410479514d35ecf74a2cf6b3c0a02e2e',
  "scripts/flash_ph_02_ideas.png": '3ac776537b20b01e32d321bdbd4ac806fbaf0ee9',
  "scripts/flash_ph_03_pick.png": '4daf377118d6e9c76d7fa19b906729925b2481ed',
  "scripts/flash_ph_04_discount.png": '400c6ba7cdd80984bb80aaea7ca70bf5a814e754',
  "scripts/flash_ph_05_when.png": '8db88620ac41ba057f7a15835c19277e86a18e69',
  "scripts/flash_ph_06_review.png": 'f0587190bf80a14dbd6d4de0e052843928c7c9ae',
  "scripts/flash_ph_07_headsup.png": '4d61672b20420ba881174973cae9438b3582b0c5',
  "scripts/flash_ph_08_customer.png": 'd1766f58bfd194fc77db1e197c37e3d81b990194',
  "scripts/flash_ph_manifest.json": 'e61cc4b2e45f6270a3dd84ebf4089a4e0b30e5f0',
  "scripts/funnel_report.js": '4d0189461d6521fa75df7af0e7a53a7ae341cce5',
  "scripts/guanyi-daemon.js": '25b9920dcda47f3e6c2a3f63b1c98fbee3c5d523',
  "scripts/guanyi-login.js": 'ba63934db19c297e0aee870776b154aa534538c4',
  "scripts/guanyi-pickup-report.js": '040e69c929202252f213fdd2d77918f051243668',
  "scripts/guanyi-probe-orders.js": 'f51ca562844b3708e80cba7d2c7b4aa21be8d7f2',
  "scripts/guanyi-probe-orders2.js": '560ebb1aee20a971bdde840aeefadbc88b6fd84c',
  "scripts/gzgrocery-order-daemon.js": '73dacb3c2e67fc2933f93bf94d89777a18a75e30',
  "scripts/gzgrocery_import.json": '3e83ff17ee9fdae8374e2d1bc4ccfa24d6945604',
  "scripts/health-watchdog.js": 'a49b77a59d2277def8498dbcd693a420f3ae005f',
  "scripts/import_descriptions.js": '38128383829c5f77f412ec75869d9ba767f0d833',
  "scripts/import_full.js": '929f45ffc61a88b53cdbec75df8bca49f186fad4',
  "scripts/import_guanyi_pricing.js": 'cdbca75ca12b9dc0069c802413ee0465dcee1b6d',
  "scripts/import_gzgrocery.js": 'b1168a4e6e97619b3929a6d390025512bbc58766',
  "scripts/import_meituan.js": 'cdb739c4ddb95c471d407df6b478336f00facad6',
  "scripts/import_miniapp.js": '8b3a8aead4a0829d1b26e1d8954b705e9167f8c8',
  "scripts/import_products.js": '5445a50e8db37761af6eae7941f4f75a80c41d37',
  "scripts/import_yogurt.js": 'dc910766d21c7fde8e7148bd1ed4875d5987c44a',
  "scripts/inherit_variant_blocks.js": '1367334aa2b283c224d6ec9794591d46ef5a2229',
  "scripts/install-backup-cron.sh": '6e7b462be54bfc9f3ccaa6c0c2db7eae08ffb05e',
  "scripts/lib/m-fakeserver.js": '4445c33d6393be52db713b289d5a17f6e3876999',
  "scripts/lib/m-probe.js": '5411cfb0f966e10192ab8785bc07c2a65d644757',
  "scripts/make_bundle_images.js": 'd0ad5851d41f60ed7793e9e96ceba3d1b8e16999',
  "scripts/make_desktop_mocks.py": '5887577ba76d0c33ae65a7814a1126501d600d18',
  "scripts/make_flash_desktop_mocks.py": 'f14f4844c8148ae6c930d35ca67e0884ce908b16',
  "scripts/make_flash_phone_mocks.py": '1caf16e0ecd48cce392f2ea082bb866016995a4d',
  "scripts/make_flash_plan_pdf.py": '38fc29a19ebad1cd73048dc5540b9efaff62da5c',
  "scripts/make_name_suggestions.py": '0e5c8afed27179444ec21e4e8020335eec8a79d6',
  "scripts/make_phone_mocks.py": 'aa14e9c21821978c24ff2c09e6aa6b72fba8c4c0',
  "scripts/make_safe_db_copy.sh": 'ed8a32b3ec7d65a97645dfdf7407d59829d2b234',
  "scripts/make_tacet_icons.js": '808ae943641c69938fdc3da20d39db3cf3573cc3',
  "scripts/make_voucher_desktop_mocks.py": '6a757910ec9ca20d44842953d3eb668e92facbd7',
  "scripts/make_voucher_phone_mocks.py": '19695eddb38d766948991a03dfa998bd5c71f5f0',
  "scripts/make_voucher_plan_pdf.py": '958c82a791e2eb00c4065bf149cbe19fc79bb60f',
  "scripts/make_wizard_plan_pdf.py": 'ac693b76b438d23d34faa63ebd34df6ad8fcaac9',
  "scripts/mark_free_by_design.js": '978dac4abf0aad03df17138e6f77291b4cceaa61',
  "scripts/meituan-apply-catalog-changes.js": 'b9bb4b6b6407e2fda1dd602cf9a2f75fe593a4e5',
  "scripts/meituan-capture-stockwrite.js": '3cd9ae149e3795cd2370c2a8847a6a79e09b1f2e',
  "scripts/meituan-daemon.js": '84cdf2502b9ea70c5f85893a57082d21ffa36017',
  "scripts/meituan-diag-name.js": '8c5cf5e83bbe3a79706c4235c8904ef48ea9cf98',
  "scripts/meituan-dump-listings.js": '46e3397e6afe9a081cff9db8f03a03bab20f266b',
  "scripts/meituan-dump-stockdom.js": 'a13f3d9aa41d34558f61b022dc667ff422d540ad',
  "scripts/meituan-dump-suggest.js": 'b52c952180813bf2098679b1da32773f3f8e1241',
  "scripts/meituan-login.js": 'b6ba3319bb1d5950ff3a9a65e61f4012de6f114f',
  "scripts/meituan-match-catalog.js": '219edad0acc6c0ae3cbf13c7f4229b8343b5254d',
  "scripts/meituan-order-probe.js": 'b78bb5d1a1a8a8f81565bc10be46eda105f2b524',
  "scripts/meituan-order-probe2.js": '48427c7d3d50c9ccd00dc79bc3943eef229a99d9',
  "scripts/meituan-order-probe3.js": '72d1198350f0951010ec0eac7bd8e42493919cb5',
  "scripts/meituan-probe-cats.js": 'fc5f531915a35154731a5933492f4e70766edbf0',
  "scripts/meituan-probe.js": 'f9a99f9b229642f684f8723033089355fd2568fd',
  "scripts/meituan-queue-status.js": '59afe58d996ba9335c52f266c7af5be76b4d12c6',
  "scripts/meituan-scrape-catalog.js": '7d3da37460432712007d77ee38c4b355df98cd73',
  "scripts/meituan-set-stock.js": '1309dea872b2af69d5dce48583b5c7ec5c15be4a',
  "scripts/meituan-status-recon.js": 'd6eee3304365d841d860dd5e76c99ddf59f726a5',
  "scripts/meituan-status-recon2.js": '964d6693ab96b3fd4fae7a5e262aeb27c22da536',
  "scripts/meituan-status-recon3.js": '3ed77b532e9c78ae7bec6f39c233af59d8907add',
  "scripts/meituan-status-recon4.js": 'a6e580625697f452f56d0973eb615440c3090d54',
  "scripts/meituan-status-recon5.js": '954cea39bb8565d8a63a5e80316581c4b46de638',
  "scripts/meituan-test-apistock.js": '7241a06ae23c0395b12cc9a21fa9f13f4a088130',
  "scripts/meituan-test-combo.js": '247d688de3c10ea6f9f9dd3d87a425bb2784ec5e',
  "scripts/meituan-test-editstock.js": '04a13e33fa44b7676b4d761c1c28a9c0b721ad60',
  "scripts/meituan-test-libstock.js": '834b62f9494690e7439c4c01aa9fd1005c245625',
  "scripts/meituan-test-libvariants.js": '909e14e6f43f745ea23aff09d6dacae19531063d',
  "scripts/meituan-test-resolve.js": '94572bfc0b93c3b881749a3ddc23c83281bf63a9',
  "scripts/meituan-test-variants.js": '743130bd00dcf8bab6546093b2a5c373d3e4a2c3',
  "scripts/meituan_tianhe_2025_08.json": '38a7f8f69834eec6e22cf322751dcc26a59770c1',
  "scripts/meituan_tianhe_2025_09.json": 'fbef1ccc80e0628e95feef0a4de0de2d2c3f57a7',
  "scripts/meituan_tianhe_2025_10.json": 'f5658d34c73f8c5852002b3b8fdd267f56ebdc83',
  "scripts/meituan_tianhe_2025_11.json": '8e2f30040eedb8dfa19948680ba483f8e6cd8baa',
  "scripts/meituan_tianhe_2025_12.json": '4d4f4692d19cde85e30799f9e2fbbf4fa62054c3',
  "scripts/meituan_tianhe_2026_01.json": 'd183ffb1ef0f8796106644b44d2750d325f10bbe',
  "scripts/meituan_tianhe_2026_02.json": '5848084704e4b21ce3173fa2c12ad4959576e738',
  "scripts/meituan_tianhe_2026_03.json": 'dd62393a67b9236bdd36dc67457cae3ce59f0018',
  "scripts/meituan_tianhe_2026_04.json": 'c1b9cb5831b19f4aa2765eae54832f7c391deed7',
  "scripts/meituan_yuexiu_2026_01.json": '178829cf620278145b01d7e6371f6fc55325e06d',
  "scripts/meituan_yuexiu_2026_02.json": 'e6e24d33e7c0c355bea38368ce5683c0301b4c63',
  "scripts/meituan_yuexiu_2026_03.json": 'd554b9db9426bd1bca5302ef72b0b070ed841b5c',
  "scripts/meituan_yuexiu_2026_04.json": '054b23f2b3471d6c6895ca3837b4a2cd83a70e49',
  "scripts/migrate_money.js": 'b6c3a65e4fe4a62de633032a1497835819c54fb8',
  "scripts/migrate_role_keys.js": 'f2edd2d95ab30580fe131fe2311a250124eaf6cb',
  "scripts/miniapp_2025_import.json": 'e5a5bd34d8b3bd0c88d2d074743b1a237b9f6915',
  "scripts/miniapp_import.json": '6e443a3d0429d0bea652e26f66e4dbdd6bbf1c08',
  "scripts/name_suggestions_apply.json": '0e99d842d6a634d960a54cc292e42f0c0bece57f',
  "scripts/normalise_finance_categories.js": 'af4ac231374216b965f579ddfec2fe75f273c1c4',
  "scripts/organize_categories.js": '4547d6d45063c674f5e3be3247b490c4cf836538',
  "scripts/pickup-window-check.js": '026117ffbdadb7996a809cac58e4221cec94cc9d',
  "scripts/post-commit.hook": '2c687238e1c1f136c60399cf8f6fa4eff21cf6a3',
  "scripts/products_import.json": '4abc4ced348e33729004b3f9cf40ba7bbdbd5401',
  "scripts/proxy-watchdog.js": '3a86ff0786a13262e067cfd83191c769d606ab8f',
  "scripts/qingyun-chrome.js": '6e364799480b495a032021f4678414bb4854822d',
  "scripts/qingyun-daemon.js": '7c492bb4a7accdb03c7929fc54f4176afa2dc306',
  "scripts/rederive_zero_cost_materials.js": 'd6ee93ab7855674d19223757cb5b6b26273022ca',
  "scripts/regions-curated-en.json": '04038694dec0180765da8384e7864c369c199206',
  "scripts/rehearse-money-migration.sh": '54099bd5a4b601ac2610fe9ee97246ec811ed62b',
  "scripts/render_flash_mocks.py": 'f4e790871f9856a6e35aadccb3b74fc61b99e3af',
  "scripts/render_voucher_mocks.py": 'e5418695670751c6c77a017310a2d069c8577d98',
  "scripts/repair_eleme_ingest_backfill.js": '3fa089b8c94bef09bfa7e473cf7cb3d4ace772b6',
  "scripts/repair_eleme_missing_eta.js": 'f231c91d29bd87157b4ba278a0150f7469f79a05',
  "scripts/repair_eleme_order_fees.js": 'f114b0d667662620fe2fd191df8b152f6403b097',
  "scripts/repair_eleme_phantom_orders.js": 'e51d8146cec73e775a674fdc507fd851f5337e5d',
  "scripts/repair_guanyi_false_pickup.js": 'f18687362dcfa2237267f8c4a1e15de43046961f',
  "scripts/repair_ingredient_cost_2026_08_17.js": 'e7a425165cedb15470d648864a02612afa334276',
  "scripts/repair_ingredient_cost_writeback.js": 'd8544ab03dbdb84d3e00210c789a2b0744378d3c',
  "scripts/repair_per_piece_recipe_unit.js": '8f061c22a852d28f930167da626cbcb1265d0d96',
  "scripts/repair_sweep_cancel_reversals.js": '7300108adc44268cf661dc018963d984aa08ac83',
  "scripts/requeue_guanyi_errors.js": '32e6334ad4e207dffd92a2575c856cbeed93272b',
  "scripts/reset_test_orders.js": 'c2ad299ccd73a3836073cd5796182b7db34ed9fe',
  "scripts/restore-test.sh": '8acaa55242a4bf9763a70d4373d166942cb2210a',
  "scripts/restore_recipe_data.js": 'e1ad9d6722478c1947ad5c8b3c3a2e069c9a2916',
  "scripts/restore_unused_made_materials.js": '1e6d8ae70941f9b4154897fbd52fcc7bdf04c081',
  "scripts/rollback.sh": 'a9bb2ab7b8c4bb13480158ad2c91f4235768b26c',
  "scripts/rollup_made_material_costs.js": '67f54366860d19de1f0665cb0e11fe2b8642daee',
  "scripts/run-suites.js": 'baa0e6bb8e1ad018155ba809bed7e267e7166676',
  "scripts/seed-starter-home.js": 'fed3eb364e3c11cc6a182f7442690ba84918bf90',
  "scripts/seed_about_account1.js": 'c2f3097212af256dbe493bf3c73b978635b96dad',
  "scripts/seed_fake_descriptions.js": '907668b7ee2856eb4bd5587eeff6fd36feb2bb38',
  "scripts/seed_meituan_bundles_tianhe.js": 'dde99d954b2f12fcf38ef79bc1acf472b183de70',
  "scripts/seed_migration_credits.js": 'eeb64be871d1f52be9e0b832fbaeaeca4333b61b',
  "scripts/seed_migration_roster.js": '22370cba4ca0a56ce010b5d099e21f938beef129',
  "scripts/seed_migration_unmatched.js": '1a1d3d41f8095175ad26c8894f5459ecb955256d',
  "scripts/seed_missing_store_stock.js": '5382233b5b9a3696a430108e6f8dd87b2b46f9f6',
  "scripts/seed_synthetic_reviews.js": '336e52592bf47577d4aae727cd57fcdc2fd2b49d',
  "scripts/seed_variant_groups.js": 'c6050bb42d8934959294ee239bf1b5981c4df5dc',
  "scripts/set_gz_district_zones.js": '08d5417329fe53503a23f72ac1cb4a4e19c0ac3c',
  "scripts/setup-oss-backup.sh": '9871b5b69e5b29d01f4bd160eb0e05d9c040a6d5',
  "scripts/shangou-chrome.js": 'e292c34fdb4f502f6cda06a4900c17e57d30a100',
  "scripts/shangou-daemon.js": 'd4c9516a611f35df2b360db2010542a54da57472',
  "scripts/shangou-export-session.js": 'ae9d791abfd829c253c79a5dce1f8ddd11385024',
  "scripts/shangou-inject.js": '83ab77b72466bd8df1f7aa7165ef23f9a3ba927e',
  "scripts/shangou-map-seed.js": 'da1b74c207c249798fb7afbb0900144cf08d0a74',
  "scripts/shangou-order-sniffer.js": 'eebaab9f8bb8bb51628ae139c020cb756a018572',
  "scripts/shangou-status-read.js": 'c2f3c82c827f964ec97b6fdc1bc07e3f3ac4a56d',
  "scripts/shangou-status-recon.js": '197a1f1a769d238d945b694b8378bf4b071b52ff',
  "scripts/ship.sh": '77817db52dbb0c9f88f06140c0072995981c587c',
  "scripts/shoot_mobile.js": '8c691eeec76354e573a086757f9c126985c5cea0',
  "scripts/shrink_home_media.js": '58999ab58b61924e99351058d0a77bdb1f887f0e',
  "scripts/shrink_store_images.js": '6c5daadc3aa57465ad9fb48c99907fe2aa6112a2',
  "scripts/slot-label-check.js": '4bc0a99db1fd6ffc3bbf50cec6fe20572a824720',
  "scripts/split_retail_js.js": 'd34d4fe6f0042386512290116608800b72fea569',
  "scripts/strip_weight_from_variant_names.js": '8de45110f5c9b0a5558c1d6b413d660572bfa800',
  "scripts/suggest_gzgrocery_aliases.js": '6015f9f851f58bed8a893a81726d1c5b619b8394',
  "scripts/sync_home_cn.js": 'ecb7c8e99cf5bad8caadf18f1df1b7ff4d28c63a',
  "scripts/test-db-backup-prune.sh": 'c6dedf6d7ed425f55eac5b87e1a45f0cd334d2f1',
  "scripts/test-deploy-base.sh": 'ac2c6d66dd7fb909970e56ef52584e424b0baefc',
  "scripts/test-fulfillment-reroute.js": '1fc9b2856a22cf94e20759cf94e1fbf289bb9a1e',
  "scripts/test-seam-mechanism-bites.sh": '37955769664db62c1e708309a861205eb385971b',
  "scripts/test-support/memory-db.js": '4b1721d0266b426c83e0d25e9f07c245cbc32924',
  "scripts/test-support/tenant-fixture.js": '91083af6321d216178845a2ccd28681113319e27',
  "scripts/test-support/tx-detection-fixture.js": '1f667d1f93dc8e13f451964155e613e31b7417fa',
  "scripts/test_about_editor.js": '0b07b4c976b46b2153054301012512cfa5679793',
  "scripts/test_addon_stock_gate.js": 'e19184563be4916a8f7ef33efb47e64ba8121ba7',
  "scripts/test_address_clients.js": '1a9661f9b833e4ce14e15629fb97c572c296862e',
  "scripts/test_address_pin.js": '2e8121e2f4d3172d6bfbe8bbac7522f8976ed616',
  "scripts/test_admin_dates.js": '89b0c640f148e810b3e22186ecbf785adb3da203',
  "scripts/test_affiliate_new_customer.js": 'afc9454bbe87223f239dc16c9aef352e344f73af',
  "scripts/test_alert_audience.js": 'c5d81fe784c72d636492bda6f25afcf0cf26c207',
  "scripts/test_app_home.js": '1b369d87197cc28d34f12c4f456bdcbc307ac83f',
  "scripts/test_asset_delivery.js": 'b3539c8185fc7dae6634071f2b3f4119cfa4c2f3',
  "scripts/test_awaiting_restock_client.js": '0e0ceba4a452a7da29f3aa660d3b20f34074945d',
  "scripts/test_batch_timing.js": '800ce811947ce1925cbd4384912bf8a8b60cc3d8',
  "scripts/test_brand.js": 'd69e937c60520f51c5a453c16cf5796ca58793ed',
  "scripts/test_broadcast_expiry.js": 'baf64cca666d06011e32185f9178b77d43ebc684',
  "scripts/test_business_day.js": 'e61f573402fa878a7ef907bb73b20a3f52d3f467',
  "scripts/test_cancel_reversals.js": 'b385109786c50fa921fe733c37af86d733e6aaa5',
  "scripts/test_capability_gaps.js": '53522eb9a8cf890fb9a1221c915570e2376cefb2',
  "scripts/test_channel_drift_sweep.js": 'f68f22d2387d4f6b74922244a9c6d2ca8a1b6ce2',
  "scripts/test_channel_hub_binding.js": 'd23ef0219bd92a2c05d28eb5d405126c582e9741',
  "scripts/test_channel_money_panel.js": '1c538ed016517d06adae828befcbc828d586c9cf',
  "scripts/test_channel_settlement.js": 'f7671abf91ade2fdeb56b679ab7c4c46516cad31',
  "scripts/test_clear_filters.js": '9e447b895d1a145b704a01a3778801c46b8822a7',
  "scripts/test_cms_currency.js": 'a18878f46e16cc42bc6618a8d9f69123ae78b0b3',
  "scripts/test_compose_prompt.js": '637fbab28a3e629253b13d11f8378f92100d72a7',
  "scripts/test_cost_incomplete_flag.js": '59199415576fe036ed6a9f0823228fac5e3ea96f',
  "scripts/test_cost_rollback_block.js": 'b669806e14b9db2a04839ba155706c087adfbaf5',
  "scripts/test_counter_sweep_exempt.js": '5b125be60388c7ae094174cf3d15517b19d4081e',
  "scripts/test_created_by_fk_migration.js": 'a5ce765a35ab23c83b6c07800c685a4298aad921',
  "scripts/test_csv_import.js": 'bfeba09503fe2edec37e8d77cebfc590784ca4b3',
  "scripts/test_customer_currency.js": 'd4a86084d8162b251df1fa63073329c880dcbe73',
  "scripts/test_customer_search.js": 'a804d246ab528cf6810a836738103bc4c7bbef0a',
  "scripts/test_db_transaction.js": '34f7644a4d393367651d49b64de8d1abf8fb7ffc',
  "scripts/test_db_transaction_nesting.js": 'cf628a4e096c7bd19ac91edce7b49ccb072071e5',
  "scripts/test_delivery_districts.js": '0f8f6f82ce1432ff03baf4a84e0457242a432618',
  "scripts/test_eleme_fee_backfill.js": '6093cd0b975e76dd8b1e291846677d4950c8ac16',
  "scripts/test_eleme_ingest_backfill.js": 'a65e7c83cd470bda71147bfcec42b26670077d74',
  "scripts/test_eleme_order_fees.js": '47b07052afe446a24fe920be7852fd49e5c76462',
  "scripts/test_eleme_order_parse.js": '1289685c4ec2446f8cbbf2545f982a0bcf6b0746',
  "scripts/test_finance_category_normalization.js": '6d045d23ee5ecdff6ede73636a7e49fac2ffffc8',
  "scripts/test_finance_presentation.js": '9a758f4b8bc9a94873705b147b39e05d95775062',
  "scripts/test_finance_summary.js": 'cf33000ff59fca7e9c7748f5c9b8193fe939bad5',
  "scripts/test_finance_transactions.js": '243520b5573d707047c740eb06f13ac85d4f9c51',
  "scripts/test_guanyi_session_expiry.js": '18997581e121a63224ceb14fb2841400b0d8bdca',
  "scripts/test_handle_threading_batch1.js": '7e98dab428ac7f567b1a41d0136f7cea24e161be',
  "scripts/test_handle_threading_batch2.js": '3b365714e58b055f8808bb93cccf38acc080f0af',
  "scripts/test_handle_threading_manual_customer.js": 'bc14824e7d538689174cf5f0f135d0bfcb9b96b0',
  "scripts/test_inbox_fires.js": '6bc023f653a51a5b2b77b83ce9877c83d536b17e',
  "scripts/test_ingredient_form_cost.js": '50ef487f381b22b8de04fdf65d0ba05d1fe4f183',
  "scripts/test_integrations_env_atomicity.js": '4a42ab532e292ac6798ad476bb686a1d8eab6c61',
  "scripts/test_invoice_no_invoice_mark.js": 'af48c1fe894faef9997efd4f8644ff4bd47fe944',
  "scripts/test_invoice_no_payables.js": '75601dae3ee9048a668b2664eb3d4f559ac446cd',
  "scripts/test_invoice_recorded_off_chase.js": '0d6fd2e3a4b51fb7bd5601088bce954115ae6347',
  "scripts/test_invoice_rematch.js": '5cd631b8e7f4005ff79551dc84c92cfa082f3e9c',
  "scripts/test_invoice_rematch_screen.js": '7a9dc5f232433a6dae2e062bb58b021751eca9ef',
  "scripts/test_invoice_supplier_search.js": '212330812c3d9d018dc59eee6cac065ec1630d5f',
  "scripts/test_keyboard_reach.js": 'e682660d2bc78cf62dc3ca0d221c8a95506ff728',
  "scripts/test_kitchen_po_copy.js": '04cccbee1fb6b9a5667d8053554c44a8d28beee1',
  "scripts/test_kitchen_po_picker.js": 'fc2e6ad0654fbe46bb2cc70e3105b50cb40f89a0',
  "scripts/test_kitchen_print.js": 'fa48d709b7cbf195799593f4188beafbbe3ab0b6',
  "scripts/test_kitchen_queue_reachable.js": 'bb73cdb811d40a00c6a57ba6c105d41b87f12994',
  "scripts/test_kitchen_ready_signal.js": 'd0c96a751f507cbad045d234daefff05f45ad47c',
  "scripts/test_kitchen_stock_visibility.js": '10861da86e912ddbee7d4401b0b1626227277bb5',
  "scripts/test_ledger_invariants.js": 'dcf06bd6f3873033b75b8535400177b59c472f94',
  "scripts/test_local_fresh_notice.js": 'f06e8c7470ff80c439f7bcaa60c2031362bcfa38',
  "scripts/test_manual_order_fees.js": '4e8b586cc15074a1c8c437f1ca208ce25b503b43',
  "scripts/test_material_arrived_tooltip.js": '57b58df1bda0eb5359ba409f33079c275ecd3f7c',
  "scripts/test_material_cost_visibility.js": '09583397d7bd8933c4605c96515d14820beadb6c',
  "scripts/test_material_supplier_picker.js": 'b48530876c8b53500e7866ac35917c7e2e06c5ac',
  "scripts/test_meituan_queue_stall.js": '7b663d0087b3c9990a1493eac1e03ad4f56497a3',
  "scripts/test_meituan_queue_window.js": '7b020be1c2ffc638d75197b72f6b68d8d46fa658',
  "scripts/test_migration_credit_ledger.js": 'fe6c995ab9b468001254d72cfe84e56052e9f3d1',
  "scripts/test_mobile_activity.js": '771cc4071c0c21ce6252c53dd5c40b1a0bbefbc1',
  "scripts/test_mobile_addstock.js": '2d65f1a1608b67e6e4d196ab5bd893de23078668',
  "scripts/test_mobile_categories.js": '460b14074cd5df3c91d605124027e61c957b9e2a',
  "scripts/test_mobile_club.js": '6d7e512398ccf49ad38b861aab8dea2282d949be',
  "scripts/test_mobile_customer_record.js": 'b3bd074cdbba9ab43b49d56b4316593f8a86c8ab',
  "scripts/test_mobile_dots.js": '54dba69048fa6805001b8ce336f87864a6e34b25',
  "scripts/test_mobile_geometry.js": '7138d5f5b3d1d37664c6d27c735b92baa9c0c0d1',
  "scripts/test_mobile_home.js": '2ba0caa84d3b4207097f399c70744aeafc864da1',
  "scripts/test_mobile_i18n_names.js": 'ebe2ad8ba364a2747b20da766025a4dda225d3fc',
  "scripts/test_mobile_inbox.js": '9f2d8fa746d43460d6f151acf2e4f6f287f521bf',
  "scripts/test_mobile_nav.js": '0b8f584403e995e2cdb2e4b6bfd02de171fb1da1',
  "scripts/test_mobile_order_from_record.js": '65b21b2109e7c5c8bd9ab7be008d20875e3e93df',
  "scripts/test_mobile_orders.js": '740df03f914c488bf011c1ca291c53d6e6aaf6fe',
  "scripts/test_mobile_payment.js": 'd0f9c45c8d9d32d16c500feead87635ac5c8b588',
  "scripts/test_mobile_production.js": '8fa5afdb86a4f5b657797880e8429d5baf487f19',
  "scripts/test_mobile_products.js": '8cfff7b4385dda12179691bb91ff13372aa7fc48',
  "scripts/test_mobile_purchasing.js": '6e7420487285b44ed158977972a331f74942119e',
  "scripts/test_mobile_pwa.js": '34328a225fb214aee56078d36ea6780250b0f1c7',
  "scripts/test_mobile_receiving.js": '7b26a14cebd626d399fa444bcb4f2d69e09a5589',
  "scripts/test_mobile_rider.js": 'be4df6fd43b8f2ce0a95596150692c55f3a2047d',
  "scripts/test_mobile_sales.js": '463c66cb19b43b6c8e865f71320eae5757921762',
  "scripts/test_mobile_screens.js": '36336a53e53f595ba14c0460075e7f699116a642',
  "scripts/test_mobile_scroll.js": 'afdbebaac5620f0cbd7b4342db67f7a35d872f03',
  "scripts/test_mobile_settings.js": '8155a7c348f52b69dcac7e509a69338269c35c24',
  "scripts/test_mobile_team.js": 'aee86e82262ff510644884f09b6f529835831833',
  "scripts/test_mobile_trend.js": '747158c425a6f06812fc51d9c73cd84b32a8a306',
  "scripts/test_mobile_voting.js": '1199c84452c8c45b18e93196aef06dbbbdf2a69d',
  "scripts/test_mobile_waste.js": '140db3abf1869f4856df9de4349c9bccee929bcb',
  "scripts/test_money.js": '914fe612d47ed3d424679bc6596e0ea47b06c1f1',
  "scripts/test_money_boundaries.js": 'd8dbc218dd523ea4cae562f957e7cf0a50b63650',
  "scripts/test_money_invariants.js": 'c1d7b285ef978f7f3f8ef4f55b905cdb5baee03d',
  "scripts/test_money_migration.js": '9b45eb4fbdb73537e3f89c6d60312711b7f39b0c',
  "scripts/test_needs_point.js": '948cbcfba5df5b717d077b175bce2520d5ddf49e',
  "scripts/test_needs_point_client.js": '5dbb0991868018a6c05e5c52b7bdaec371360299',
  "scripts/test_new_merchant_locale.js": 'a7705fbc01a741d16e87cb284c7fe05f0f30c7a4',
  "scripts/test_normalise_finance_categories.js": 'ef7dbb2d365b1d3bf6ecfb911f471c4da384de41',
  "scripts/test_notification_choices.js": 'cfa755b142d3497cbd70184c9dad9dc4a3e392ac',
  "scripts/test_nutrition_rows.js": 'bb5cbce121c68538d27810b66d1352a1df4aa2ad',
  "scripts/test_offapp_refund_guard.js": '71092066e6d05fb0fcc0dd3fcdd5497dc4fb8899',
  "scripts/test_open_close_panel.js": '0d493c76e323cb8bcec2e4ba14e80b07236d0316',
  "scripts/test_payment_mismatch.js": 'a0335ca65b5f3ddb1be07cdaa9ae70feb41f10e3',
  "scripts/test_phone_dashboard.js": 'f9824458c054961a89fac57f5e549644c4d6f50d',
  "scripts/test_phone_dates.js": '3a07403596a5b9fb6596e78d58816c45c3102a3d',
  "scripts/test_phone_order.js": 'c5f2ef2ae242b74a61440ecbbd0ea1e13ffd415c',
  "scripts/test_po_cost_unit_guard.js": 'b9d772a6913ada475e3312019c9f7b5f8214bcd2',
  "scripts/test_po_supersede.js": '1e7f81ae4c5608759cd7333f862949566553c30a',
  "scripts/test_poi_first.js": '1838cd7659e4f1799453f95531051fced791c7c1',
  "scripts/test_point_search.js": 'becaa8e2cb6eb8cf18ccd882403bc0a1d93a41e7',
  "scripts/test_preorder_local.js": '351c706259df584a6c1a1e075d1ad9a43e1d665e',
  "scripts/test_preorder_park.js": 'e9141f6a55646248aaf6a1138cccaecc55a23064',
  "scripts/test_price_writeback.js": 'd9e04c5faeb402d78fd181c7bfa54162a3e7df58',
  "scripts/test_print_documents.js": '6ac5cff2b70106aed79faf32d5bce6addad3e17d',
  "scripts/test_product_blocks_read.js": '56553c4000397645a32838d3b204723104d6e053',
  "scripts/test_product_build_cost.js": '09b8ee94fbe5a46a65a154e5e798a70775064fdb',
  "scripts/test_product_cost_visibility.js": '10020be8132a6297a9bd8910fa9a7f4c2692f774',
  "scripts/test_product_ctx_no_cost.js": '46b8d6dd2650ca053be742508768093045dfc22d',
  "scripts/test_production_log.js": '75b72e759b72292df497f11472855fd93dabb5c3',
  "scripts/test_proxy_failover.js": '7789adcdbb63d1d8c44f48bb04deff22d676f483',
  "scripts/test_purchase_returns.js": 'e56caefe8e625942999cfa84976c406c385dcfba',
  "scripts/test_purchasing_line_order.js": '682ce97875d6383e8a2e7d749b196f230ea02a74',
  "scripts/test_purchasing_line_supplier.js": 'bcc6c3998c5bc703dd0957cbe85424afaa0d92bf',
  "scripts/test_push_mute_action.js": '6299062f1af5b0ad3b60db8582dcf949c6787a20',
  "scripts/test_recipe_cost_data_write.js": 'fa45c2028a00cdf130e52ff7af9720b4599104e6',
  "scripts/test_recipe_graph_cycles.js": '6e53ad0d897462b130cf687f7a232de6da2b1ee7',
  "scripts/test_recipe_materialize.js": '3a6a59d8e62ff628353bc9eccf7ff7f0deafe20a',
  "scripts/test_recipe_materialize_auto.js": '303cc30177a897854f765da9df806daf048f7bfd',
  "scripts/test_recipe_record_autosave.js": 'd79883e462d8846db7f430921d754ae1aeb5e9db',
  "scripts/test_recipe_rollup.js": '99e2c923f8e4f17120e952237f2ae662dae22d68',
  "scripts/test_recipe_rollup_apply.js": 'c1e66086fc307f69075f604d0e64df0549082768',
  "scripts/test_recipe_unit_mismatch_warnings.js": '44386ee25d5c710cfbc3664e092e1a22972b2a89',
  "scripts/test_recipe_versions.js": 'b019bac20ea236fa491b52ba59554cace77e75b3',
  "scripts/test_recipe_yield_auto.js": '54bdc3261c654db4b97a6f60de8d5ecd3dfa049f',
  "scripts/test_recipient_phone.js": 'ce6482fc6dbe33b9c940a6090d3ef968f6a07c83',
  "scripts/test_reconcile_tier_alert.js": '25c81bfa806143a6aeee00fbf542dc1cd0c836a7',
  "scripts/test_recycle.js": '7a30c92c02763145caf0ace0aee03063087dc768',
  "scripts/test_restock_direction_default.js": 'acb4a854bced3894ffd3b665da108a31ff56bdd0',
  "scripts/test_restock_notifications.js": 'dc3d8fa98bd61d9cd69092d366630fd2e9791a99',
  "scripts/test_restock_tenant2_split.js": '6acf3df0ad35607be56d6f6b754bed89a466c8e1',
  "scripts/test_restock_tenant_handle.js": '9a9e6c3eb2205ebe5b8adaf5f136fb32b91770d0',
  "scripts/test_retail_local.js": 'a7269dff23b862e65024a7df03208f122b04a04d',
  "scripts/test_retail_local.py": '2310ffcd2155ebe41cd0d4a6314f0b1b38954499',
  "scripts/test_rider_call.js": 'a4062946db1e439b01b8ffe3a5aefce7050d69b1',
  "scripts/test_role_editor_client.js": 'd45bd0cc59ae42e6a7869f10ab20f379aff4c553',
  "scripts/test_role_tagged_controls.js": '4caa3bce71059bad871b384412b730f922d2d3a7',
  "scripts/test_run_suites.js": '2db6bdff51ae22bdc09c83c55e0b8ce6d7fd57c2',
  "scripts/test_sales_summary_partition.js": '00dbad19aed3810a3c39a3cafc174ee556be93ce',
  "scripts/test_saved_views.js": 'e11d4295df3bdf8d61b408367fe388af8b0dca86',
  "scripts/test_settings_findable.js": 'f73bb981f4170c8cace02b3d6767a7b37e6031db',
  "scripts/test_shipments_split_merge.js": '03fb2cff4e680b41d653a63e37220ae6145d359a',
  "scripts/test_shipments_split_undo.js": 'dcc7a7a9223a0516d0923877e6c03d787be20e0a',
  "scripts/test_shop_channel.js": '184b89cd6e692c7c155cf4cdda21fab6e30b85a4',
  "scripts/test_shop_listings.js": '77f8608cf1899486a714f1d5bae15793d442c646',
  "scripts/test_shop_menu.js": '3020438207a544674ec1f526cdbd359af1954dde',
  "scripts/test_shop_menu_geometry.js": 'c3be687be42c8808a6bf7769fdebefb4f0196f39',
  "scripts/test_shop_menu_render.js": 'e33c5fe28eb97ccb439e1e001ab379ac88e75fdb',
  "scripts/test_shop_order_code_admin.js": 'd3472b53e0521210044154278cb43bc8cbdcbd5d',
  "scripts/test_shop_qr.js": '23e9e042481dddbae482a4e25251f241f4277c06',
  "scripts/test_signin_code_delivery.js": 'f1a319e534b17c38d7885e75e58699c745d5466a',
  "scripts/test_sku_generation.js": 'b0b4de6b838d505a720a72e5fab9de778e70cc37',
  "scripts/test_stock_home.js": '207a3a24c2d7a08947f73816abd858f30206dd78',
  "scripts/test_stock_picking.js": '3390a65f2ae852b80c1add870c7d9d85379ba8a9',
  "scripts/test_stock_receiving.js": '9d49490542c7b77bf5cd766678e62ef752846f05',
  "scripts/test_stock_screens.js": '8a4a5ebf393eb0ca5882af0b5e4d5611987c9ada',
  "scripts/test_stock_two_step.js": 'ef198c8bab0b77c81e6b09a5552eac5dae320346',
  "scripts/test_stock_two_step_tenant2.js": '2987da8e2d215a57245eadf3bc6b2ee561c13b0e',
  "scripts/test_sync_start_time.js": '24e00efc5d53be926b81f6bbbfe4ef4a0e95679c',
  "scripts/test_tax.js": '8ebafa9906ecdd101ea2e25497a4f68ee744a8bf',
  "scripts/test_tenant_branding.js": '5ca55efba1623145634d0f40b6584ef51a8dea15',
  "scripts/test_tenant_roles.js": '9d16aedf78bfc844fc3e37653e6013b389cf2831',
  "scripts/test_till_back.js": 'e0039188e6af692023129e6b408f62b3e996150c',
  "scripts/test_tx_conversion_batch1.js": '3adf9baee5e154364a5050445a7e35071f8ca537',
  "scripts/test_tx_conversion_batch2.js": '2145297c78f097d160c72fe26a81d17c18bccfff',
  "scripts/test_tx_conversion_batch3.js": '0d77aed7f26348533e1b6423334196d6c04770b6',
  "scripts/test_tx_conversion_batch4.js": 'b68da0697e7c8870964a1fe93e2debbf078eceda',
  "scripts/test_tx_conversion_manual_order.js": 'b8b2f7a60b66b9eb6cc506bdf5947560f8042421',
  "scripts/test_undo_receive_clears.js": 'b6de02a8aad57511e3dd801b7045324a1a32c2d6',
  "scripts/test_unit_cost_sanity_warning.js": '73d9b003ab5bacf32da8759db86ca3cf6e14db22',
  "scripts/test_warehouse_store_pin.js": 'd06210b4d593d0b259c362ff55cd706ddd36b63e',
  "scripts/test_waste_cost_visibility.js": '60e974151f5c67787c2929dbea7cdbb74dee216a',
  "scripts/test_wechat_oa.js": '025ade9c78e6a9f3ebf451a6b75914014a2b8aac',
  "scripts/test_wizard_first_question.js": '3fea84e2f272c80fe94481bbbcd9d59f5fcd5f24',
  "scripts/test_wizard_line_supplier.js": 'd5aa4dd97d8b0523956661c062be57697259b0b3',
  "scripts/update_sh_bj_zones.js": '7fed6beca01e3974662ca9a904293c415b7d43c9',
  "scripts/verify-closed-store-routing.js": '41c6b0cc4a8a4156bc96b2696d58a39bbed15c3d',
  "scripts/verify-fulfilment-types.js": 'f6dc25fcb5c926a73895a914a45f2f9006b84d19',
  "scripts/verify_made_material_links.js": 'b81e7dc0d24a46107437dfbb8ad7ce594ae75ded',
  "scripts/voucher_pc_01_front.png": '4c822f24a6da0cebeaebfb7100d22c26a9f1bec8',
  "scripts/voucher_pc_02_ideas.png": 'fe70b5440507fd0fa354443a20dac68daf934c2c',
  "scripts/voucher_pc_03_describe.png": '9ba2677107d75d0ba41ec4968947acb80d54c0f1',
  "scripts/voucher_pc_04_deal.png": '2ea456331937a6875373335d71c204201a7ba492',
  "scripts/voucher_pc_05_who.png": '2d6497460706a71cd10180056482b747e3e8798b',
  "scripts/voucher_pc_06_rules.png": '73377f44c162c9555bab4816ed7570e1a060d01a',
  "scripts/voucher_pc_07_review.png": '038a0e9a87bd3621530881da6f23b4e9eb644c3f',
  "scripts/voucher_pc_08_headsup.png": '0f4ba1a7fbf27029fe77c4b4f60b8f62c1a7060b',
  "scripts/voucher_pc_manifest.json": '93d9ebd204fe5d0283f4fc21e400778232b4776e',
  "scripts/voucher_ph_01_front.png": 'a4e7f04e19bac1ea04e8855b1f559ec2014889f0',
  "scripts/voucher_ph_02_ideas.png": '09c31f84484eb90f9b5b2d8c734d98cfc873e630',
  "scripts/voucher_ph_03_describe.png": 'e48918d112aadc0813cba38fe464b9e7d4b57f0b',
  "scripts/voucher_ph_04_deal.png": '3fbe77e50915ed3d8b1aa366ac68255036ee9634',
  "scripts/voucher_ph_05_who.png": '3c4f5592ff786e06afe7ff9ac9f141816a731c7b',
  "scripts/voucher_ph_06_rules.png": '5d63a128cb2910d7f4c683c5b799cf34a5476440',
  "scripts/voucher_ph_07_review.png": '80310f75075f9e6b6a006c8fe55c25413a9ca5ff',
  "scripts/voucher_ph_08_headsup.png": '95c800509c86cf699bbb2286393be0afaa9d254a',
  "scripts/voucher_ph_manifest.json": '3b5a3450fb42628c23be6cf4c7bbe9240157272e',
  "scripts/wizard_mock_desktop.html": '05bab0408c869ef27e4091eff0aa8594c9e32bf2',
  "scripts/wizard_mock_desktop.png": '3debcaae9c0cf520f0f13fdef6654950ba206dfc',
  "scripts/wizard_mock_phone.html": '8c65204b3756a9c0b014ab2701598b4ff772387f',
  "scripts/wizard_mock_phone.png": 'ca45e4e7c12709ad77f488c19947d770aa1f41be',
  "scripts/wizard_pc_01_front.png": '6fd032e887b608436f1f2b81ba2fb1c74d30e604',
  "scripts/wizard_pc_02_step1.png": '8bdb510b6084225bebbdd1268cdf7e8a01cb40e1',
  "scripts/wizard_pc_03_step2.png": 'db08617ed58cb9c80af5b1a9f452a6b13a65d197',
  "scripts/wizard_pc_04_step3.png": 'e649b996ae46b2e54609d63f805aafe415f648ff',
  "scripts/wizard_pc_05_step4.png": '2dde03122e859bc4056e89c26298066dc1237cf8',
  "scripts/wizard_pc_06_finish.png": '899a88c0aa92ce33ed661d480ac7c73be17a7f9c',
  "scripts/wizard_pc_07_import.png": '35b1fa0e4def6e46f9e16c341e9cff8541125cf4',
  "scripts/wizard_pc_manifest.json": '70efda5fa9e20aeca78c452329268d20ba6b4077',
  "scripts/wizard_ph_01_front.png": '8c5565eca2ff136d62f5c1488f92305d4e22c608',
  "scripts/wizard_ph_02_step1.png": '6f3a17e82d5de09593e9f7f4c4081584a3b19058',
  "scripts/wizard_ph_03_step2.png": 'd70e8f0e48159ff3a537579b01670ad256b59344',
  "scripts/wizard_ph_04_step3.png": '54f3c1b491e348cb43f848e604cbbeab0a1e9d5f',
  "scripts/wizard_ph_05_step4.png": '8a8cf224f57d5efc911f8800767c8c1c30e0c271',
  "scripts/wizard_ph_06_finish.png": '6def24f48b9e931cee350564f11ea930c3ed9db7',
  "scripts/wizard_ph_07_import.png": '8e73dbf225359305d2c69142305d28b04990d56e',
  "scripts/wizard_ph_manifest.json": 'f07fc89b1b97079d5d29b32df643f7d93d9f9aa0',
  "server.js": '92310d44da00643e4615259ee2684e64bb65737c',
};

main();
