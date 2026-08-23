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
// ════════════════════════════════════════════════════════════════════════════
const MANIFEST_COMMIT = '1364b153cbd638c2ef098acfb4687d5ca9d49535';
const MANIFEST_SW_NORMALIZED = '111c63ee2b74d2eb289b23ecbfad6d5c51399ffa';
const MANIFEST = {
  "database.js": 'bb24a6f850c1eb2973b20043439d2eb2e6b09a23',
  "lib/address-cn.js": '12d738c662f7583d63ceaa8b00380c7cfab99696',
  "lib/address-pin.js": 'ae110a22c6caac8cc9f9e60d77eccfd2ed2c1d4b',
  "lib/alert-latch.js": '4642e6bed92eba75fa15f8d7ecf7afac308b268b',
  "lib/alipay-ocr.js": 'b7b7d7850c695f7c532b8ebc7099061863a7a112',
  "lib/aliyun-sms.js": 'e37cbd0ca0c206432ab64982910df0aebe4a92d3',
  "lib/billing-lifecycle.js": '92378adf6e6cd660e069955b7191e0b7e47420bb',
  "lib/billing-providers.js": 'bab3caee8775b0d0a6a2e7882c47d6f4584d1251',
  "lib/brand-designer.js": '40b35994bf85d2f16c695fc058c472e18a6ed216',
  "lib/brand-fonts.js": '46af474c365d7b2a1dd427b08f4e9621f134ac56',
  "lib/brand-gates.js": '7943ee5c57e29bfab4219295f7ad58e4ca08c8e7',
  "lib/brand-theme.js": 'f78b6784728245afa4145f08f5ec6d98299e2651',
  "lib/brand-tokens.js": '0362e829cd17ee5114cb4362f1b254e5329cd4ce',
  "lib/browser-env.js": '2c8aa644a011f6ec03e85e8c9bdf61ba521357d9',
  "lib/browser-warmup.js": '75c1fc987f976fc300b5f3a5b258dda367f19bee',
  "lib/cap-routes.js": 'c002a1cd0ded4c4580905958b58f4f3345a4d684',
  "lib/capabilities.js": '7346a5d32eb0df4b88ad089df4bdeefc5d862c39',
  "lib/category-tree.js": '30d054811b35b3d6ae4f0a7e12433c42cd00b28f',
  "lib/china_districts.json": '3d129d1b1e70b1811e9d2682f4be0f0869f82e79',
  "lib/db-driver.js": '1e2cea38a94e3abd23f8dec88253b5f33861c8dc',
  "lib/db-seam.js": '7a8f90960ce8249f51b0c5012ff418c863bcadd2',
  "lib/db-transaction.js": '82645f30208b3dc91f6a4303c1890f7f6920a6cf',
  "lib/delivery-reminders.js": '285b3ee0b6eab68316965f4800c804ac20926c5e',
  "lib/eleme-client.js": '5d45527fda8cf831129f5d13efce12c83eab829f',
  "lib/eleme-sync.js": 'de3f4cde439415ee0b844c1a66884c26743d4229',
  "lib/email-sender.js": '3f7314c57d732d4c4844ca73c5147c89d97fe983',
  "lib/express-async-guard.js": 'd4b120aca139eced6ce969702b7401224bffe463',
  "lib/features.js": 'd11c1b4cce3e3e6b365493074751d0dc29b85a1c',
  "lib/feie.js": '4a86afc142db77a14dbe7045a69f5bc9483c2e31',
  "lib/flashsales.js": '2a89a02327382f774730235d70f8f3ab1ade1abf',
  "lib/fulfilment.js": '9559061c04b3620b84fbbb4b19a4606583807a98',
  "lib/geocode.js": '5ec146e2c0d7b4ce2e39e63c7715aa29b3e08f05',
  "lib/guanyi-browser.js": '207e89b1add949daab462243022cda5753729e9b',
  "lib/guanyi-sync.js": '48a4b4a6fe96960e14a4ff4be0586a92ac79d05d',
  "lib/gzgrocery-admin.js": '9229cf7ffa8ccb1bafce95f4310f8075a0912ab6',
  "lib/gzgrocery-order-notify.js": 'f733f692cff72c4328e026da9da3e7e63ff2a93d',
  "lib/image-dims.js": '3a9e6ff7a5b731ac7abbf15316594b1e6dcda036',
  "lib/ingredient-cost.js": '9139f88b2ffa6c18522db77204ec3e50606e93f0',
  "lib/integrations/registry.js": 'ce25d65979977b127fbee780c118d56bb078a061',
  "lib/integrations/session-relay.js": '7267c7e4e8109a82a766d4ffe8df0fc24a3798ab',
  "lib/inventory.js": 'f0f4181e7a4861b69465db960a6117a6285caaaf',
  "lib/jd.js": 'acae7c38322e828a2611ccc98c2de1a4d6a54382',
  "lib/meituan-browser.js": 'e309d9b05fdce25604aa1233f0062a1f2c047726',
  "lib/meituan-bundles.js": '9e75fc121f4681a64e4340179964c1e12e5f2efc',
  "lib/meituan-drift-sweep.js": '976a14d5d2990c0f272a427951c63c96aa990e4b',
  "lib/meituan-queue-stall.js": '0e8d62f1b34baf0672865b0f772986a62f57cd97',
  "lib/model-gateway.js": '678242662b442e80aa6af5dd3a409cd80d76a7b8',
  "lib/nuonuo.js": 'c32140cf60d1c9135f890e5e92c25a6c7e816961',
  "lib/onboarding-steps.js": 'd24c09394a759d1a30ad8119ffdd7ef27452b0d5',
  "lib/operator-caps.js": 'b7a7e2a4ae29691b23c921b8e6072f881be8a3b8',
  "lib/ops-alert.js": '05cedd982d468043e7c645137a05f796734da936',
  "lib/pg-handle.js": '01fd7389bd4a73e6ab4213f331fa5e87eaead10c',
  "lib/pg.js": '9d21f741808f9be3d434e90d1c45dc9891839b40',
  "lib/phone-cn.js": 'aaa9a429173472a4adf524567320cad81ace5673',
  "lib/platform-admin.js": '0420ad762a7b2f45db71825fe9339807fd14a75a',
  "lib/platform-alert.js": 'f04e48790ada5f04632137fa99b1d1027725c218',
  "lib/provision-tenant.js": '2b2e16f5c7c71720944c92aeddc1063796a14650',
  "lib/proxy-manager.js": '529d52abc3ba88dad92be260583b47ffc13745f8',
  "lib/qingyun-browser.js": '577985a000619033139a2860170e2ca71c5879be',
  "lib/qingyun-payload.js": '8c4694ab32dd921284e7c1c049543fd542f79e76',
  "lib/qingyun-queue.js": '6e6fb34b83da73a996c7b6dad5a737b61860996d',
  "lib/qrpng.js": 'b2302c664a88eaeea9b1e597d80160f3b5bceb78',
  "lib/recipe-cost.js": '4e960a9d46e8b303b07e3892b47f54304f2b1c25',
  "lib/region-i18n.js": 'e6bad1453ac523f3b988af0e7de8244d7bb4414f',
  "lib/require-cap.js": 'abd6c0498df8ea25535461221a02a5a288a21d41',
  "lib/secret-box.js": '6dd2d764b215ada290d380c09eea2dbb6c9666e8',
  "lib/shangou-browser.js": 'ac3730ecebe6f36c629b96f06aad7e4c60a32fbb',
  "lib/slot-label.js": '32c008f09ca0b75dfb5bc0b5c97c6ea2dae1f72e',
  "lib/social-auth.js": '092b434a5411bc1ebff6c1f0474184feb4205cb0',
  "lib/store-hours.js": '81008493b50c1beac7221030cd81da6db6130a5d',
  "lib/tenant-creds.js": 'ef61609f423021e97e9cd19e12234a97fde60b6e',
  "lib/tenant-db.js": '7e5f63f8fc3c8dd2cc093874c7a321bbba255d99',
  "lib/tenant-notify.js": 'f4a933208c5ca7aa609aa414c2228f54f614646f',
  "lib/tracking.js": '65983befb407c9c55b103ac9ff3cb3bbd2daf409',
  "lib/wx-sec-check.js": '1042f7ea8cefc9355d41753a9f192dac6ee83159',
  "middleware/auth.js": 'ae2a99cf84911db6d3d3534a73c683341bf41dc1',
  "middleware/public-tenant.js": 'b93126509f30ddf8b1ab4c10a829938b09bffffd',
  "package-lock.json": '85ea48c75a6a1d7ead42fc9accac62cecfb6aecb',
  "package.json": 'd60dcd681e8341f58a36f2119af0c32203d3c96a',
  "public/app.html": '7cf3cd97a50b20a483ae750d947afbbfa7fcfd21',
  "public/app.html.bak": '5991891f0060f97c4660f4d25b26a422d6845b9e',
  "public/apple-touch-icon.png": '52f0d35477978e0bcccf81dff1a2fa4237ca97ae',
  "public/assets/cms-mobile-mockup.html": '19ba9d62bca2d093ae79afcb386310444e7cdd6b',
  "public/backend-account.html": '0efda64fbc9db1bb1cb59949421ee69de67d7daa',
  "public/backend-billing.html": '6980b270350651491dae614c3f23a955e3933bb8',
  "public/backend-brand.html": 'f52d32c3647bf81de354155ec894976219395c75',
  "public/backend-login.html": 'c2027d145b5ed6e84ed5d86280b3a22ba172cd02',
  "public/backend-signup.html": '0e0189ba476777d02e0312ffd42f10c62fcc0afe',
  "public/backend-team.html": '1d9bd9dcc579a20e7e59a907be55f2c2205a3b73',
  "public/brand-studio.html": '6497d5cc60ace7fe2508e74454feea1b7858ebf1',
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
  "public/cms-mobile.html": 'da1efbda3d04a89aacae965d7ae817909bbe1a7c',
  "public/cms.html": '69731464c334e23d593899373840849636c3abcf',
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
  "public/kitchen.html": '7805616f936788285c8ca44ed7a8b57dea6dc624',
  "public/login.html": '5cd46e9cc5a747c4717ff2a3f4f76364a6b5e308',
  "public/m.html": 'e6925a81078f2e267d1bb8c9e53fe90c72fcdbee',
  "public/manifest.webmanifest": '0f6513b9b45220bc3f4d6dcf7e240ef98ea5c9e0',
  "public/pos-icon-192-maskable.png": '8176b34f04d6338f0df79779241a15997e0c0a90',
  "public/pos-icon-192.png": '0a85c313e45e17625a93a8a01fae2143b01db519',
  "public/pos-icon-512-maskable.png": 'ae387246724320b6beb29c967b2658a860b35b25',
  "public/pos-icon-512.png": 'b35d4dca359687b19b11f81caaf0a7992f0f4ea2',
  "public/product-editor.html": 'f0da6731c5251672053bd3f60dd6185860a8706c',
  "public/retail-admin.css": '9a84935615a3ea47ab98e826606ccfe5dec8b7f7',
  "public/retail-admin.html": '42eada87e543e7b74249dc67c6763d78eb2a90be',
  "public/retail-admin/01-core.js": 'd7f73ae491e092fe1501bc73b145fd2eb30b9752',
  "public/retail-admin/02-settings-ops.js": '7f552f664ef224e7eaa40f328dba8403a6d1784d',
  "public/retail-admin/03-dashboard.js": '355e3845c2d5020e05e552faf37744edb5701017',
  "public/retail-admin/04-orders.js": '7cbddcd8ae9e53ecd14cc4e7c200ffddd2e87fa8',
  "public/retail-admin/05-marketing.js": 'e6481f91c2bd3c46b12ac3d3364f84290d4ba1c9',
  "public/retail-admin/06-delivery.js": 'e0d4c04f54fa1764ff2f1105ec93beed47a671cb',
  "public/retail-admin/07-content-billing.js": '08c5ebd83dc18ecf9890e5d62237ebd4ec72c578',
  "public/retail-admin/08-customers.js": '4ad9d5392ed1e512153bbb1c970c388288056c54',
  "public/retail-admin/09-products.js": '2cae31a839e419d839306ab53707e7afdce7c695',
  "public/retail-admin/10-extras.js": '2eff8e251c857c6ae4b7191c5409e4bf3f8b1c17',
  "public/retail-admin/11-meituan.js": '34ef9efc412266907917470ec6d35c49679aed34',
  "public/retail-admin/12-guanyi.js": '284ac575f01d8112192ed70e59a92394d0877d60',
  "public/retail-admin/13-activity.js": '24df879288267a5892ee610d7997d431afcee436',
  "public/retail-admin/14-eleme.js": '0d2940986be5b0cde3f3bd22b6fa6f86fc6b5856',
  "public/retail-admin/15-integrations.js": '67af59ef6b8e6784f29f58dd6bdfde2531903c7f',
  "public/retail-admin/16-purchasing.js": 'd775ed7623e634a5774392546accbd0d0b19d837',
  "public/retail-admin/17-setup-guide.js": '52a2bf25e789e592ac0446059d13bf766d3fea75',
  "public/saas-admin.html": 'f619eecf363eb3524bf1e771b3b5988258387e8c',
  "public/shop.html": '43dd75b29ef169011182c3f10f52cabf300341eb',
  "public/shop/_gallery.fixtures.js": 'cf8a878460a769d6560c21d156d6b133520e33ee',
  "public/shop/_gallery.html": 'ad653d21f3366dc7e93b70df60f9c404947d5658',
  "public/shop/_gallery_frame.html": 'e829fd800a08b74621f1c9fc900843da6f8d4095',
  "public/shop/_mockups.html": 'b32c9b2d5f3877849e61c03c41525624eb708375',
  "public/shop/blocks.css": '539b7ebe5c87f6b18b22e04def0e5f76ec15e3a2',
  "public/shop/blocks.js": '2c7dd92743e112fdadf9fd697db465bea18ab4c8',
  "public/shop/product-blocks.css": '94ffbd20e5e088db1dc7e7eb20db1cb573d669ce',
  "public/shop/product-blocks.js": 'ed2aaf42ba3621a3de663a544c5046e5022bcd0c',
  "public/stock-icon.svg": '0a60278f12f5989be772b50f3548f485fc35831c',
  "public/stock-manifest.webmanifest": '2dd64879e772a3fcc733854f278db34713c87d70',
  "public/stock.html": 'b859cb359cc5c0e442d63c4f34e4d33fcf9def18',
  "public/store-admin.html": '521282047ed7e906dffdfc815ae9b87741b832f1',
  "public/storefront.html": '06096448a17ee5e9b652283863e2ee8df54cd13c',
  "public/sw.js": 'eb0aefded5a8bfd15e773d575b7a64b600a59b2a',
  "public/tacet-dialogs.js": '30e404c5be3c51a523777bd9bd005501e62688f1',
  "public/tacet-favicon.svg": '960020f8858f89edb0505b00e4e020445c960718',
  "public/td-datetime.js": 'fd8dec5987fea2c03726ab02f42003165439fb54',
  "public/till-manifest.webmanifest": 'e613d95a6043bf104c384fd06e7243f0ba688b98',
  "public/till.html": 'd309446059b44e439f9874d55e8ea9721c176c23',
  "routes/admin.js": '06e86c8e4d4bccb2554e9d3e338247e6a895ec7f',
  "routes/ai.js": 'c26fea7b39a74aefb55705891f8c16e8de59a37e',
  "routes/alerts.js": '6d629f3fd7a2a3a3fc483c8bd6636491da548898',
  "routes/auth.js": '3d520280b079019869074c60504fafc657773f8f',
  "routes/backend-auth.js": '590923a4c9f0b00db495cf788698ae9c51b6e8b2',
  "routes/backend-notices.js": '886b45a327fd5225db31ddb38731fd111773deca',
  "routes/backend-signup.js": '8c08594abd54234fdd81a5a69fd4284fefe7e526',
  "routes/backend-team.js": '3ab82c498195a25791a67f550d4780c3899c830a',
  "routes/billing-pay.js": '07674172e275953f1586ccace5448f312327cd71',
  "routes/billing.js": 'd10d79f9ccae1340bb529cb9d95253e86760f1ec',
  "routes/eleme-admin.js": '03425fd05d6db64fea4249dbab44c4cd2178831b',
  "routes/eleme-internal.js": '6d2f3c7a0628a81bdefc9f1456b29e83f38bd52d',
  "routes/events.js": '193a1b0f6560c21770a1ddf0d693afd3dd7aee9b',
  "routes/feedback.js": '4abf3f9a71436778ce1fa35ddfd666c5cf676483',
  "routes/finance.js": '9232919fb7333c8fd445ec95ea7e3c985ee353dc',
  "routes/guanyi-admin.js": '119544ac210903f3d83dc3c3f1919dfdc93ed9a5',
  "routes/ingredients.js": '670efdfeea39f6c3f2eeba4bad4511b98b25bb30',
  "routes/integrations-admin.js": '7730f3ed59bdb5b23f0f1e4190ffa0d17fa5ef18',
  "routes/kitchen.js": '6f208a1029ceba97342d8becdf75ddb05e88740c',
  "routes/lookups.js": '02d3edcf8bcc850c45bd9ac91615971e744be8bb',
  "routes/markets.js": '69f8e7bfd2f90b8d15d866d31f9cb5ae2ff27488',
  "routes/meituan-admin.js": '0b31a3c37e20e3a4ea9579ea310bfd0824598454',
  "routes/meituan-internal.js": '17c52e782cef02df0ead42d50a90fb0a6f1f3f68',
  "routes/pos.js": '5144e41f33dc53042cfddd203c7ab68b59957687',
  "routes/production.js": '70de5470845688c564251a4d8b0b003881f98116',
  "routes/products.js": '00bd30d822a6ed5a885dde25b5a6ec12d3920039',
  "routes/purchases.js": '5cd096c6fd69e2b3f96bbcae5034c9c089ab2d38',
  "routes/push.js": 'fff5a5d798f57e8b69657f86e1ff67232cebeeaf',
  "routes/recipes.js": 'e523a4b25fe41fba8afe567c185fb3e3eee44d38',
  "routes/restock.js": 'd023fcce76ca78edc546c808e7ea146567b7876c',
  "routes/retail-inventory.js": '82ebfe8201079154e30ed46d516d0241e1386189',
  "routes/retail-page-templates.js": 'bd8782806bf36a3b86aff74e91ea9654cc3b9161',
  "routes/retail-purchasing.js": 'ec40fc0bba21c1c03f02bdcb34ab8e6f2eedb07c',
  "routes/retail-setup.js": 'a4c48e135e71f97f4afac6e51c77a06a6d5d400a',
  "routes/retail.js": 'c4d5ff6666d85027329d94283f2efc66e4587a14',
  "routes/saas-admin.js": '8bdd46230968a09b6148e18000d6aecc5b11cf92',
  "routes/sales.js": 'b6faef77ef43b9fd16ad40dbfb7cf4cb45b7263d',
  "routes/store-admin.js": 'e552b5132c9fa42c8aa1a6bc8333bb1a14d49ecc',
  "routes/waste.js": 'b97dea1371ff7aecbdbf5f9ab259077b8fe84447',
  "schema.sql": '8ae4f8e7787274a7d755a04f245916af9fd83515',
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
  "scripts/auto-push.sh": '3081691e656977c5d286356fa40617f57ee4fc6f',
  "scripts/backfill_addon_payments.js": 'fb4110285e2053a5866e31ef41bdec6824388468',
  "scripts/backfill_addons.js": 'ba897570e5333682c98219427707edbc38c58867',
  "scripts/backfill_doubled_address.js": '51de8ef88798d0670f39a4acdaddfe9496df4dfd',
  "scripts/backfill_image_aspect.js": '4cfed69f9e97017998d1f0995bb79592646498ab',
  "scripts/backfill_order_tracking_mirror.js": '333275d5e370b0decd498259d222941d787e0647',
  "scripts/backfill_refund_requested_to_paid.js": '39952500dd5bed11ecf9e96c7152ca5926721cfd',
  "scripts/backfill_shipment_tracking.js": '9f354d83b84cd02063a9f9488f2a6677fc92dbb6',
  "scripts/backfill_weight_from_spec_strip.js": 'e5a244c2698654c1208a900ce5cdd6139b7fe344',
  "scripts/build-regions-dataset.js": 'a2fb8dbacacf1453d8efa74da39d8c1c9ccd7735',
  "scripts/build_gallery_fixtures.js": 'f11c902d22a53f1aa1e56efe3cde2c256e288ea3',
  "scripts/build_migration_roster.js": '74cfcd17c299ab38748a3d0551d845f164dcdda5',
  "scripts/catalog_text_dump.json": 'a9e6bd28acaedbd53d5cd02067a2102cd951b96b',
  "scripts/categorize_items.js": 'cadb1904125cb7bd16bc629cb6c0e917b2107199',
  "scripts/check-default-passwords.sh": 'cc18739a243774e9bc967f5a7542113aedae27a4',
  "scripts/check-html-js.js": '91c62df445b136fb62166f1720f153aec6966d4c',
  "scripts/check-i18n-banners.js": '5a76513a77aab1b708b0aa41760d1076fcc89fee',
  "scripts/check-tenant-als.js": 'ca68bb41ba4b679b5ee2986e96496dca794b2dfb',
  "scripts/check_ledger_invariants.js": '48d0eaabd3b9b3de00de3af004d83f0ed80037d7',
  "scripts/check_points_invariants.js": 'db900b449b5cde7b9765afeb2fd1b28888340b41',
  "scripts/check_sync_freshness.js": 'b431ea47e8686979e9fbb99c33b4cbcc961108f3',
  "scripts/clear_stuck_refund_R260618156719.js": 'f4e3bf0fb97b25c59c154581640a32bbca19d9cc',
  "scripts/collapse_zones_into_default.js": '95141695ffc2261a968eed51190ad9282cb96a3d',
  "scripts/compliance_edits.json": 'a3411473eae31950e7c9e485048961e11c03ce73',
  "scripts/consolidate_guangdong_and_hk.js": 'e5fc692235bd9986fffb66cea7dac77e5abecc08',
  "scripts/convert_gzgrocery_xlsx.js": '9bf58f03996098001ba006adc187d7486f202033',
  "scripts/convert_meituan_xlsx.py": '4bb104a2410413c085dab474f0e286bde219e576',
  "scripts/copy_hummus_extras.js": '269a54f08b28b3a7e2776a29f026a3fed42b8536',
  "scripts/copy_soup_options.js": '0c109115abd8aac1cdb5390d5b522e3af3bbfd36',
  "scripts/db-backup.sh": 'ade6f718787e59e32ac389ec17752daf2bad586d',
  "scripts/db-seam-coverage.js": 'a3ce3265fe58bb83793b06c431cced61837733d3',
  "scripts/dedupe_province_covered_cities.js": '2a15ea6a400d9a7d2b98f89ad8f53e505535c55a',
  "scripts/deploy-apply.sh": '09287f7f102e59cd92c9df5a58c5219d6cb50688',
  "scripts/deploy-changed.sh": 'a52f9e929dff887a11a91c9117258a6f3784e84a',
  "scripts/diagnose_addon_stock_misses.js": '1ff3f1e3fd84a160270528c7cbd2e11853e16186',
  "scripts/diagnose_address_pins.js": 'b28f208cd0409a380019179069531bc2323c3dea',
  "scripts/diagnose_async_conversion_scope.js": '377b6adedde76245ad04535a2244bd5b13b7d4d1',
  "scripts/diagnose_doubled_address.js": 'f09e82dc0b5e7134dd8ff2ef2ef57791251663d6',
  "scripts/diagnose_fallback_store.js": '6917e9f319e5537151c05028242f105ae4c5f734',
  "scripts/diagnose_guanyi_errors.js": 'a2e9a26d6f44926662626731ba755dd75aa97d4f',
  "scripts/diagnose_gzgrocery_stock.js": '125ffab5f9d136678701cc272c225ffe6f655832',
  "scripts/diagnose_migrations_ledger.js": '5580d5f0e4badd0957b5388d3b8ca8846b6d36d1',
  "scripts/diagnose_money_unit_mixing.py": 'dd89177db12b74bd3365cfc17d7afc0b48c038ac',
  "scripts/diagnose_money_unit_split.js": '98e3142159747c24be58dc123b63cf21020c98d5',
  "scripts/diagnose_pg_numeric_parser.js": 'cd6714b89d73713e355850686debfd6be6e48005',
  "scripts/diagnose_proxy_state.js": '47b474733181cce8fcdbdc34599aba63eeb3c521',
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
  "scripts/dump_catalog_text.js": '5011a574fa870750ef2fd40a4dd7309ced2eb17f',
  "scripts/eleme-daemon.js": 'a2a732db15f1d66f246a2dfe16a43271a8d451c8',
  "scripts/extract_retail_css.js": 'fa7dab6ca9fc47f65ce6c4fe62e099565afe9095',
  "scripts/extract_retail_js.js": 'ff1f1d03d00515f246d9ccb8e5ae3de2952cec52',
  "scripts/fix_default_zone_lead.js": '41ce06a276d701e8e5ed72ee33ac4598867ab7e2',
  "scripts/fix_duplicated_product_names.js": '7d16c20fd8751cf422535ca4e306641758bf61c0',
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
  "scripts/guanyi-daemon.js": 'ad54d607a3d15cdb17f3445857bd7bd4a5b86bb5',
  "scripts/guanyi-login.js": 'ba63934db19c297e0aee870776b154aa534538c4',
  "scripts/guanyi-pickup-report.js": '040e69c929202252f213fdd2d77918f051243668',
  "scripts/guanyi-probe-orders.js": 'f51ca562844b3708e80cba7d2c7b4aa21be8d7f2',
  "scripts/guanyi-probe-orders2.js": '560ebb1aee20a971bdde840aeefadbc88b6fd84c',
  "scripts/gzgrocery-order-daemon.js": '2ae02cbc40d0a0681643d316d49d98be4669bf28',
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
  "scripts/lib/m-fakeserver.js": 'e53a62ab58142ec7c77e535b0079b68347325b8d',
  "scripts/lib/m-probe.js": 'c502819f23b1f1323ba556c447ec1543a223654e',
  "scripts/make_bundle_images.js": 'd0ad5851d41f60ed7793e9e96ceba3d1b8e16999',
  "scripts/make_desktop_mocks.py": '5887577ba76d0c33ae65a7814a1126501d600d18',
  "scripts/make_flash_desktop_mocks.py": 'f14f4844c8148ae6c930d35ca67e0884ce908b16',
  "scripts/make_flash_phone_mocks.py": '1caf16e0ecd48cce392f2ea082bb866016995a4d',
  "scripts/make_flash_plan_pdf.py": '38fc29a19ebad1cd73048dc5540b9efaff62da5c',
  "scripts/make_name_suggestions.py": '0e5c8afed27179444ec21e4e8020335eec8a79d6',
  "scripts/make_phone_mocks.py": 'aa14e9c21821978c24ff2c09e6aa6b72fba8c4c0',
  "scripts/make_voucher_desktop_mocks.py": '6a757910ec9ca20d44842953d3eb668e92facbd7',
  "scripts/make_voucher_phone_mocks.py": '19695eddb38d766948991a03dfa998bd5c71f5f0',
  "scripts/make_voucher_plan_pdf.py": '958c82a791e2eb00c4065bf149cbe19fc79bb60f',
  "scripts/make_wizard_plan_pdf.py": 'ac693b76b438d23d34faa63ebd34df6ad8fcaac9',
  "scripts/mark_free_by_design.js": '978dac4abf0aad03df17138e6f77291b4cceaa61',
  "scripts/meituan-apply-catalog-changes.js": 'b9bb4b6b6407e2fda1dd602cf9a2f75fe593a4e5',
  "scripts/meituan-capture-stockwrite.js": '3cd9ae149e3795cd2370c2a8847a6a79e09b1f2e',
  "scripts/meituan-daemon.js": 'd02e7654954d1fedacc46072871e2e50188c002f',
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
  "scripts/miniapp_2025_import.json": 'e5a5bd34d8b3bd0c88d2d074743b1a237b9f6915',
  "scripts/miniapp_import.json": '6e443a3d0429d0bea652e26f66e4dbdd6bbf1c08',
  "scripts/name_suggestions_apply.json": '0e99d842d6a634d960a54cc292e42f0c0bece57f',
  "scripts/organize_categories.js": '4547d6d45063c674f5e3be3247b490c4cf836538',
  "scripts/pickup-window-check.js": '026117ffbdadb7996a809cac58e4221cec94cc9d',
  "scripts/post-commit.hook": '2c687238e1c1f136c60399cf8f6fa4eff21cf6a3',
  "scripts/postgres-full-copy/.gitignore": 'dd409ca95d62552867f2ed5ea3029e3c27728913',
  "scripts/postgres-full-copy/README.md": '53e552089679f35b4d49d6243a5fe82c12c9e62d',
  "scripts/postgres-full-copy/census.py": 'af0659051e846e177a4248473dcf10f5f6500e08',
  "scripts/postgres-full-copy/checks.py": 'f52e0d29d65ae63facc6886e1ddc59fa34ff7b10',
  "scripts/postgres-full-copy/drift.sh": 'bb818da3c347c896523733f1f930e324dabe788e',
  "scripts/postgres-full-copy/drift_guard.py": '4ad5edbb5a46eb89001765ede1af7c3f9b0c09d2',
  "scripts/postgres-full-copy/drift_proof.py": '6974962ea7c2f4bc245c7d9a5826f4a6df841360',
  "scripts/postgres-full-copy/final.py": 'e23d74b6418595d58af033389a11160b27d5def8',
  "scripts/postgres-full-copy/gen.py": '0503726aaa2152065125043e8f68d28a6d276682',
  "scripts/postgres-full-copy/money.py": '745a8c232752ecf5fd406f59875c2ae00d6be795',
  "scripts/postgres-full-copy/money2.py": 'fab47625921d0e21b012b7c4a03c472d3269e099',
  "scripts/postgres-full-copy/money3.py": '2548650e377f875fe8bb810ebd2acddddbcbc466',
  "scripts/postgres-full-copy/overrides.py": '6d84b28e927a95b3d50e929deb8a9e6c33862827',
  "scripts/postgres-full-copy/plan.json": '6eff09a5775a9da196a33fdf6cb71a1e08a3c745',
  "scripts/postgres-full-copy/precision.py": '6b09b1b61a79ddb208a68b189235f342f5eab7d7',
  "scripts/postgres-full-copy/preflight.py": '060b9b7ed03463bc0b8240404b80b27c713fda73',
  "scripts/postgres-full-copy/report_timings.py": '61c7e6f199816a68dc13c8d11ad35a03dc21efbe',
  "scripts/postgres-full-copy/run.py": '68f7c090b357b2f72da89e18cc8b26c78253c360',
  "scripts/postgres-full-copy/seed_order_counter.py": '4384b375ed11aa6ff25ebb123eee2b8fa47b38e0',
  "scripts/postgres-full-copy/setseq.py": 'cb882008292d80dd088f7da5b19c096d0437bfe4',
  "scripts/postgres-full-copy/survey_pg.sql": 'cd8a0aef80b92b1c72b27477b4f6339ae7961877',
  "scripts/postgres-full-copy/survey_sqlite.py": 'b69b9e655bc7e2273ff0d435702c5b581e1bd747',
  "scripts/postgres-full-copy/verify.py": '397478a1d10cd4d4f1c8a0af16a0c3b0c57e1497',
  "scripts/postgres-full-copy/volume.py": '54c0a949404d1fdc0c5345f696379a9522744d9f',
  "scripts/postgres-migration/README.md": '93b191367121215857e42f308dadf0612b092fe5',
  "scripts/postgres-migration/gen_accounts_sql.py": '579a7434ea5443695637d8cd37b387d79a9621c4',
  "scripts/postgres-migration/gen_migration_sql.py": 'ff7f7c0cc056955aaa667017ec80135aab0c956a',
  "scripts/postgres-migration/verify_accounts.py": 'b9f2b96412d9e22bc39b37361de0636fa9d6294e',
  "scripts/postgres-migration/verify_migration.py": 'eea0110adcb2afd636c323d79d446998ec3355c2',
  "scripts/postgres-money-scale/.gitignore": 'ea48bc90403af0cc7f41af3692850aae252df618',
  "scripts/postgres-money-scale/README.md": '5e1af5ebcc4da6eedb0880457958baf7a01ff7eb',
  "scripts/postgres-money-scale/make_fixture.py": '8c72d848654b54a02b7478f1cb65855ef1c25798',
  "scripts/postgres-money-scale/money_bucket.json": '5c605e877cb4912c85d78b1bba2fe8f3e0bae63d',
  "scripts/postgres-money-scale/money_scale_census.py": 'aa6467b9105230c5c89da78acdac6af03c891387',
  "scripts/products_import.json": '4abc4ced348e33729004b3f9cf40ba7bbdbd5401',
  "scripts/proxy-watchdog.js": '5ab0ae98489fd65b811b49b8c3cfc33a8ba9010f',
  "scripts/qingyun-chrome.js": '6e364799480b495a032021f4678414bb4854822d',
  "scripts/qingyun-daemon.js": 'ba290363132be8e4f19263e484223abd8531d2d0',
  "scripts/regions-curated-en.json": '04038694dec0180765da8384e7864c369c199206',
  "scripts/render_flash_mocks.py": 'f4e790871f9856a6e35aadccb3b74fc61b99e3af',
  "scripts/render_voucher_mocks.py": 'e5418695670751c6c77a017310a2d069c8577d98',
  "scripts/repair_guanyi_false_pickup.js": 'f18687362dcfa2237267f8c4a1e15de43046961f',
  "scripts/repair_ingredient_cost_2026_08_17.js": 'e7a425165cedb15470d648864a02612afa334276',
  "scripts/repair_ingredient_cost_writeback.js": 'd8544ab03dbdb84d3e00210c789a2b0744378d3c',
  "scripts/repair_per_piece_recipe_unit.js": '8f061c22a852d28f930167da626cbcb1265d0d96',
  "scripts/repair_sweep_cancel_reversals.js": '7300108adc44268cf661dc018963d984aa08ac83',
  "scripts/requeue_guanyi_errors.js": '32e6334ad4e207dffd92a2575c856cbeed93272b',
  "scripts/reset_test_orders.js": 'c2ad299ccd73a3836073cd5796182b7db34ed9fe',
  "scripts/restore-test.sh": '8acaa55242a4bf9763a70d4373d166942cb2210a',
  "scripts/restore_recipe_data.js": 'e1ad9d6722478c1947ad5c8b3c3a2e069c9a2916',
  "scripts/rollback-delta-report.js": 'b77c4c5630b00ac5d538ae720a008425360e2cb9',
  "scripts/rollback-to-sqlite.sh": 'bd296787f5d9a4c63f2529d42ee05a57d523f663',
  "scripts/rollback.sh": 'a9bb2ab7b8c4bb13480158ad2c91f4235768b26c',
  "scripts/seed-starter-home.js": 'fed3eb364e3c11cc6a182f7442690ba84918bf90',
  "scripts/seed_fake_descriptions.js": '907668b7ee2856eb4bd5587eeff6fd36feb2bb38',
  "scripts/seed_meituan_bundles_tianhe.js": 'dde99d954b2f12fcf38ef79bc1acf472b183de70',
  "scripts/seed_migration_credits.js": 'eeb64be871d1f52be9e0b832fbaeaeca4333b61b',
  "scripts/seed_migration_roster.js": '22370cba4ca0a56ce010b5d099e21f938beef129',
  "scripts/seed_migration_unmatched.js": '1a1d3d41f8095175ad26c8894f5459ecb955256d',
  "scripts/seed_missing_store_stock.js": '5382233b5b9a3696a430108e6f8dd87b2b46f9f6',
  "scripts/seed_synthetic_reviews.js": '78042be39a396f2025f4b364660d792d37589d1d',
  "scripts/seed_variant_groups.js": 'c6050bb42d8934959294ee239bf1b5981c4df5dc',
  "scripts/set_gz_district_zones.js": '08d5417329fe53503a23f72ac1cb4a4e19c0ac3c',
  "scripts/setup-oss-backup.sh": '9871b5b69e5b29d01f4bd160eb0e05d9c040a6d5',
  "scripts/shangou-chrome.js": 'e292c34fdb4f502f6cda06a4900c17e57d30a100',
  "scripts/shangou-daemon.js": '5904e63873d0b365b0c2f61d2bcb428a1657740c',
  "scripts/shangou-export-session.js": 'ae9d791abfd829c253c79a5dce1f8ddd11385024',
  "scripts/shangou-inject.js": '83ab77b72466bd8df1f7aa7165ef23f9a3ba927e',
  "scripts/shangou-map-seed.js": '9cf4c722f0579a028805b26027164a8550e9d07d',
  "scripts/shangou-order-sniffer.js": 'eebaab9f8bb8bb51628ae139c020cb756a018572',
  "scripts/shangou-status-read.js": 'c2f3c82c827f964ec97b6fdc1bc07e3f3ac4a56d',
  "scripts/shangou-status-recon.js": '197a1f1a769d238d945b694b8378bf4b071b52ff',
  "scripts/ship.sh": '77817db52dbb0c9f88f06140c0072995981c587c',
  "scripts/shoot_mobile.js": '199a3bd80011ecac262f521a3c479155f84a3929',
  "scripts/shrink_home_media.js": '58999ab58b61924e99351058d0a77bdb1f887f0e',
  "scripts/shrink_store_images.js": '6c5daadc3aa57465ad9fb48c99907fe2aa6112a2',
  "scripts/slot-label-check.js": '4334bc1b83f3bb693999aba9728d26bea99bcb20',
  "scripts/split_retail_js.js": 'd34d4fe6f0042386512290116608800b72fea569',
  "scripts/strip_weight_from_variant_names.js": '8de45110f5c9b0a5558c1d6b413d660572bfa800',
  "scripts/suggest_gzgrocery_aliases.js": '6015f9f851f58bed8a893a81726d1c5b619b8394',
  "scripts/sync_home_cn.js": 'ecb7c8e99cf5bad8caadf18f1df1b7ff4d28c63a',
  "scripts/td-datetime-check.js": 'a41ffd809ae8c8fe0b6686c2b9b46977c4c99bb0',
  "scripts/test-db-backup-prune.sh": 'c6dedf6d7ed425f55eac5b87e1a45f0cd334d2f1',
  "scripts/test-deploy-base.sh": 'ac2c6d66dd7fb909970e56ef52584e424b0baefc',
  "scripts/test-fulfillment-reroute.js": '1fc9b2856a22cf94e20759cf94e1fbf289bb9a1e',
  "scripts/test-seam-mechanism-bites.sh": 'bad6d9c1702f4d9673fa966bcb21034ed5f78baa',
  "scripts/test-support/memory-db.js": '4b1721d0266b426c83e0d25e9f07c245cbc32924',
  "scripts/test-support/tx-detection-fixture.js": '1f667d1f93dc8e13f451964155e613e31b7417fa',
  "scripts/test_addon_stock_gate.js": 'e19184563be4916a8f7ef33efb47e64ba8121ba7',
  "scripts/test_address_clients.js": '1a9661f9b833e4ce14e15629fb97c572c296862e',
  "scripts/test_address_pin.js": 'bdd76c048c52243fe9c04343679d4e80ad9fe695',
  "scripts/test_batch_timing.js": '800ce811947ce1925cbd4384912bf8a8b60cc3d8',
  "scripts/test_brand.js": 'd69e937c60520f51c5a453c16cf5796ca58793ed',
  "scripts/test_cancel_reversals.js": '0cf105b3920e0433b82fb283f1836e900b721de3',
  "scripts/test_customer_search.js": 'a804d246ab528cf6810a836738103bc4c7bbef0a',
  "scripts/test_db_driver.js": '34338c0b69c6cfcdff6514be863d61dcc3bff121',
  "scripts/test_db_transaction.js": '34f7644a4d393367651d49b64de8d1abf8fb7ffc',
  "scripts/test_db_transaction_nesting.js": 'cf628a4e096c7bd19ac91edce7b49ccb072071e5',
  "scripts/test_handle_threading_batch1.js": '28ee433fed4fad2da1758581b17bc8d539d9263b',
  "scripts/test_handle_threading_batch2.js": '3b365714e58b055f8808bb93cccf38acc080f0af',
  "scripts/test_handle_threading_manual_customer.js": 'bc14824e7d538689174cf5f0f135d0bfcb9b96b0',
  "scripts/test_ingredient_form_cost.js": '50ef487f381b22b8de04fdf65d0ba05d1fe4f183',
  "scripts/test_integrations_env_atomicity.js": '4a42ab532e292ac6798ad476bb686a1d8eab6c61',
  "scripts/test_ledger_invariants.js": 'dcf06bd6f3873033b75b8535400177b59c472f94',
  "scripts/test_manual_order_fees.js": '29f2daeae6078ed839c28374ddf6a3007115a5ac',
  "scripts/test_meituan_queue_stall.js": '7b663d0087b3c9990a1493eac1e03ad4f56497a3',
  "scripts/test_meituan_queue_window.js": 'b219da30aa032aed8cbfc03b07deed38238a3cc8',
  "scripts/test_migration_credit_ledger.js": 'fe6c995ab9b468001254d72cfe84e56052e9f3d1',
  "scripts/test_mobile_activity.js": '771cc4071c0c21ce6252c53dd5c40b1a0bbefbc1',
  "scripts/test_mobile_categories.js": '460b14074cd5df3c91d605124027e61c957b9e2a',
  "scripts/test_mobile_club.js": '6d7e512398ccf49ad38b861aab8dea2282d949be',
  "scripts/test_mobile_dots.js": 'd14d8f9e2363da9d742fec3b6263ed6a436a29dc',
  "scripts/test_mobile_geometry.js": 'be38d9831d11f3d07b294e0a5acf0591c87ba7a2',
  "scripts/test_mobile_home.js": '3efd49f6ed14dacb7c4a87b8185442ecee563a43',
  "scripts/test_mobile_inbox.js": '9f2d8fa746d43460d6f151acf2e4f6f287f521bf',
  "scripts/test_mobile_orders.js": '740df03f914c488bf011c1ca291c53d6e6aaf6fe',
  "scripts/test_mobile_products.js": '8cfff7b4385dda12179691bb91ff13372aa7fc48',
  "scripts/test_mobile_purchasing.js": 'e37445eb3fc1d3c8bf4939e706123e7ccb822d14',
  "scripts/test_mobile_sales.js": '58f086c78b1881f34593d36a2a088c44f5ea2b49',
  "scripts/test_mobile_screens.js": '9dc06e2999c9ddb05b8a4e2376922c2984415ee3',
  "scripts/test_mobile_settings.js": '29d6f81def38006f1570445bed34a613db59a4dc',
  "scripts/test_mobile_voting.js": '1199c84452c8c45b18e93196aef06dbbbdf2a69d',
  "scripts/test_needs_point.js": '948cbcfba5df5b717d077b175bce2520d5ddf49e',
  "scripts/test_needs_point_client.js": '3623d7cce6ec2ac2f9bcd2d85461dcd7b7d75f17',
  "scripts/test_payment_mismatch.js": '4dea89e84e8c9657d37bcc58dd9d6634afcd4f1a',
  "scripts/test_pg_transaction.js": 'ab181062624841e83832651de1208d47667e872f',
  "scripts/test_phone_dashboard.js": 'c267eedc56703924c2509fae02b896a9dc3c1382',
  "scripts/test_poi_first.js": '405dd87c15eb6b76f70074085eb0f05d85ebd63f',
  "scripts/test_point_search.js": 'becaa8e2cb6eb8cf18ccd882403bc0a1d93a41e7',
  "scripts/test_preorder_local.js": '303ef661c67e82880b34faca88d15a41e5bb0fe9',
  "scripts/test_price_writeback.js": '98e1fcc8263486a1d19e6f403d62de6d4abdf977',
  "scripts/test_proxy_failover.js": '7789adcdbb63d1d8c44f48bb04deff22d676f483',
  "scripts/test_push_mute_action.js": 'afa87bbac337e01b8669c807122c52b21c68d78f',
  "scripts/test_recipient_phone.js": 'b04f202d666ab84473a0597feb3b4b9ded6c36f2',
  "scripts/test_reconcile_tier_alert.js": '25c81bfa806143a6aeee00fbf542dc1cd0c836a7',
  "scripts/test_retail_local.js": 'a7269dff23b862e65024a7df03208f122b04a04d',
  "scripts/test_retail_local.py": '2310ffcd2155ebe41cd0d4a6314f0b1b38954499',
  "scripts/test_rollback_to_sqlite.js": '7e1c1ee9ed0261721849f4be912d52fb9fbc75d4',
  "scripts/test_sales_summary_partition.js": '00dbad19aed3810a3c39a3cafc174ee556be93ce',
  "scripts/test_shipments_split_merge.js": '03fb2cff4e680b41d653a63e37220ae6145d359a',
  "scripts/test_shipments_split_undo.js": 'dcc7a7a9223a0516d0923877e6c03d787be20e0a',
  "scripts/test_stock_screens.js": '40465e799410ede3007827fc743344a3e4148d52',
  "scripts/test_tx_conversion_batch1.js": '3adf9baee5e154364a5050445a7e35071f8ca537',
  "scripts/test_tx_conversion_batch2.js": '2145297c78f097d160c72fe26a81d17c18bccfff',
  "scripts/test_tx_conversion_batch3.js": '0d77aed7f26348533e1b6423334196d6c04770b6',
  "scripts/test_tx_conversion_batch4.js": 'b68da0697e7c8870964a1fe93e2debbf078eceda',
  "scripts/test_tx_conversion_manual_order.js": '0d02b39e10d3b70d8883f36aa8a15024cf1d3486',
  "scripts/update_sh_bj_zones.js": '7fed6beca01e3974662ca9a904293c415b7d43c9',
  "scripts/verify-closed-store-routing.js": '41c6b0cc4a8a4156bc96b2696d58a39bbed15c3d',
  "scripts/verify-fulfilment-types.js": '504597808eda5175732fe555a1e323eb63bb4302',
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
  "server.js": '6e5b2d5ddf06eedece5e131900cc89d8627d1435',
};

main();
