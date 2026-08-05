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
  for (const rel of onBox) if (!(rel in MANIFEST)) extra.push(rel);

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
const MANIFEST_COMMIT = 'ad9451294281fce60520c5ee797126aafe3c6347';
const MANIFEST_SW_NORMALIZED = '9199c16737e6d1c86d59fca5ab6e5a61b436f8e0';
const MANIFEST = {
  "database.js": '85956ce91e13ec5bf04bf8c366d070385c1e9c50',
  "lib/alert-latch.js": 'd4003310c4d5d672bb4bd91ea8a6c3bb5cba58f8',
  "lib/alipay-ocr.js": '99b05cc04eda8b86a3bd09e0ac233755645328a3',
  "lib/aliyun-sms.js": '5dd71c6fa51589b05c08d649de2e6014eba855b2',
  "lib/billing-lifecycle.js": 'e834f931e8b6cf4c06796254ea768844a22225d4',
  "lib/billing-providers.js": 'b2a5d6537ddab4ff9cfc1ad49f5943a85d34abac',
  "lib/brand-designer.js": '40b35994bf85d2f16c695fc058c472e18a6ed216',
  "lib/brand-fonts.js": '46af474c365d7b2a1dd427b08f4e9621f134ac56',
  "lib/brand-gates.js": '7943ee5c57e29bfab4219295f7ad58e4ca08c8e7',
  "lib/brand-theme.js": 'f78b6784728245afa4145f08f5ec6d98299e2651',
  "lib/brand-tokens.js": '0362e829cd17ee5114cb4362f1b254e5329cd4ce',
  "lib/browser-env.js": '2c8aa644a011f6ec03e85e8c9bdf61ba521357d9',
  "lib/browser-warmup.js": '75c1fc987f976fc300b5f3a5b258dda367f19bee',
  "lib/cap-routes.js": '532680f78a49754bab36a6cbb8b03cad8c3c8d8f',
  "lib/capabilities.js": '7346a5d32eb0df4b88ad089df4bdeefc5d862c39',
  "lib/category-tree.js": '30d054811b35b3d6ae4f0a7e12433c42cd00b28f',
  "lib/china_districts.json": '3d129d1b1e70b1811e9d2682f4be0f0869f82e79',
  "lib/db-seam.js": '7a8f90960ce8249f51b0c5012ff418c863bcadd2',
  "lib/delivery-reminders.js": '285b3ee0b6eab68316965f4800c804ac20926c5e',
  "lib/eleme-client.js": '5d45527fda8cf831129f5d13efce12c83eab829f',
  "lib/eleme-sync.js": 'de3f4cde439415ee0b844c1a66884c26743d4229',
  "lib/email-sender.js": '3f7314c57d732d4c4844ca73c5147c89d97fe983',
  "lib/features.js": 'd11c1b4cce3e3e6b365493074751d0dc29b85a1c',
  "lib/feie.js": '2e732feca2dcfdc0bd6a5dfb0e1bd5ba85f6036c',
  "lib/flashsales.js": '2a89a02327382f774730235d70f8f3ab1ade1abf',
  "lib/fulfilment.js": '9559061c04b3620b84fbbb4b19a4606583807a98',
  "lib/geocode.js": '65dad40da83756374688f541d03fe207834fefad',
  "lib/guanyi-browser.js": '207e89b1add949daab462243022cda5753729e9b',
  "lib/guanyi-sync.js": '48a4b4a6fe96960e14a4ff4be0586a92ac79d05d',
  "lib/gzgrocery-admin.js": '9229cf7ffa8ccb1bafce95f4310f8075a0912ab6',
  "lib/gzgrocery-order-notify.js": 'f733f692cff72c4328e026da9da3e7e63ff2a93d',
  "lib/image-dims.js": '3a9e6ff7a5b731ac7abbf15316594b1e6dcda036',
  "lib/integrations/registry.js": '7ccad0bd8d04ff4673b4459a4c73ed3cbae560ef',
  "lib/integrations/session-relay.js": '7267c7e4e8109a82a766d4ffe8df0fc24a3798ab',
  "lib/inventory.js": 'e25f7ce1e1857f2bddf2a8db0758ed66592af6fe',
  "lib/jd.js": 'acae7c38322e828a2611ccc98c2de1a4d6a54382',
  "lib/meituan-browser.js": 'e309d9b05fdce25604aa1233f0062a1f2c047726',
  "lib/meituan-bundles.js": '2cea4c78820a95c4cfa6987b0c96eb0363de7dfb',
  "lib/meituan-drift-sweep.js": '976a14d5d2990c0f272a427951c63c96aa990e4b',
  "lib/model-gateway.js": '678242662b442e80aa6af5dd3a409cd80d76a7b8',
  "lib/nuonuo.js": 'c32140cf60d1c9135f890e5e92c25a6c7e816961',
  "lib/onboarding-steps.js": 'd24c09394a759d1a30ad8119ffdd7ef27452b0d5',
  "lib/operator-caps.js": 'b7a7e2a4ae29691b23c921b8e6072f881be8a3b8',
  "lib/ops-alert.js": '378629b129e266baab1885db34666533ece4baf8',
  "lib/platform-admin.js": 'eb666452b1765b04293e6bb4785efd82610bcc08',
  "lib/platform-alert.js": 'f04e48790ada5f04632137fa99b1d1027725c218',
  "lib/provision-tenant.js": '67a7f38dbc5c1a836e1257166713b4b371db982b',
  "lib/proxy-manager.js": 'd7d71c4e1f65574a98cf7eeec1ea5aee746b5a5a',
  "lib/qingyun-browser.js": 'bb942ac1803ebbc5002c15c6cf92a1d825d07a95',
  "lib/qingyun-payload.js": 'e5b464c5a6dfeeb3f92af72b186e5570fa226d0e',
  "lib/qrpng.js": 'b2302c664a88eaeea9b1e597d80160f3b5bceb78',
  "lib/region-i18n.js": 'e6bad1453ac523f3b988af0e7de8244d7bb4414f',
  "lib/require-cap.js": 'abd6c0498df8ea25535461221a02a5a288a21d41',
  "lib/secret-box.js": '6dd2d764b215ada290d380c09eea2dbb6c9666e8',
  "lib/shangou-browser.js": 'ac3730ecebe6f36c629b96f06aad7e4c60a32fbb',
  "lib/social-auth.js": '092b434a5411bc1ebff6c1f0474184feb4205cb0',
  "lib/store-hours.js": '81008493b50c1beac7221030cd81da6db6130a5d',
  "lib/tenant-creds.js": '69af7705180103c712438ca8c3128160b723bbf7',
  "lib/tenant-db.js": '7e5f63f8fc3c8dd2cc093874c7a321bbba255d99',
  "lib/tenant-notify.js": 'f4a933208c5ca7aa609aa414c2228f54f614646f',
  "lib/tracking.js": '65983befb407c9c55b103ac9ff3cb3bbd2daf409',
  "lib/wx-sec-check.js": '1042f7ea8cefc9355d41753a9f192dac6ee83159',
  "middleware/auth.js": '5b267cfe3440d9b0d3d26fd709c1b3e70d5e3480',
  "middleware/public-tenant.js": '866efe0bddd50d3628d09fa5ff742665cc54909c',
  "package-lock.json": '0eb15c940f6d4691d06bea8b224f0c2465d0f7f6',
  "package.json": 'a1fecdcf5a0bb8902d336a32e8915c19e466881e',
  "public/app.html": 'ed100e60d8294fcf4312739d48a849249c2fddc4',
  "public/app.html.bak": '5991891f0060f97c4660f4d25b26a422d6845b9e',
  "public/apple-touch-icon.png": '52f0d35477978e0bcccf81dff1a2fa4237ca97ae',
  "public/assets/cms-mobile-mockup.html": 'ae323d62c50c2fe3fc81cc4d5cebcec9f944b6fb',
  "public/backend-account.html": '2795b84bc437ec188cc623dfa39bedae967c218f',
  "public/backend-billing.html": 'f8db49069ae9ffc49dec252a856b59e9baee39b3',
  "public/backend-brand.html": 'f52d32c3647bf81de354155ec894976219395c75',
  "public/backend-login.html": 'c2027d145b5ed6e84ed5d86280b3a22ba172cd02',
  "public/backend-signup.html": '30d24ce0160a25c35a0ba8ff4b4217bac6e6812f',
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
  "public/cms-mobile-mockup.html": '7ad74698df88998ab667d18d056397a8ad0f43ef',
  "public/cms-mobile-v2.html": 'e0be44aea94c58660ef698f19de27c870bd592ae',
  "public/cms-mobile.html": '53aa3dadf49c271c65fca89387533a98fac3e486',
  "public/cms.html": '38ff317c53e41a354af8c7d92b94d7a24808611e',
  "public/editor.html": '027b7f359884f39527991a32c61ca3078ae04e67',
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
  "public/kitchen.html": 'a0200d61d0311aa336773ae0ba3c34eec1878f87',
  "public/login.html": '5cd46e9cc5a747c4717ff2a3f4f76364a6b5e308',
  "public/m.html": '8525c2b89afd8a0e0b26806e7ff272ea1fa7903e',
  "public/manifest.webmanifest": '0f6513b9b45220bc3f4d6dcf7e240ef98ea5c9e0',
  "public/pos-icon-192-maskable.png": '8176b34f04d6338f0df79779241a15997e0c0a90',
  "public/pos-icon-192.png": '0a85c313e45e17625a93a8a01fae2143b01db519',
  "public/pos-icon-512-maskable.png": 'ae387246724320b6beb29c967b2658a860b35b25',
  "public/pos-icon-512.png": 'b35d4dca359687b19b11f81caaf0a7992f0f4ea2',
  "public/product-editor.html": '2d8ae01445b461d15c717c42fda1d1a7247861d1',
  "public/retail-admin.css": '53f608e579b77da57142c48fdb58bbbbbf5f02a8',
  "public/retail-admin.html": '17382d41aad6a9eac75949cb1924c4ae4936df4a',
  "public/retail-admin/01-core.js": 'cc158be0c204216b3e7b119339595a82823c45f9',
  "public/retail-admin/02-settings-ops.js": '43b793602c96b2a4bca80b079a24a3657f7fe322',
  "public/retail-admin/03-dashboard.js": 'a7a9fa483ed00100e674a091622ab1bda6629da9',
  "public/retail-admin/04-orders.js": '096dc253da98b2bae935a1a0eea6f1110725eca7',
  "public/retail-admin/05-marketing.js": '1d8ca0aef15df93fa3f437f7bd5db2f26d11a7b2',
  "public/retail-admin/06-delivery.js": 'f307b3e8c4f9bd494b2511db36d20c27bce6407a',
  "public/retail-admin/07-content-billing.js": 'c0476d214c47deae3f9c209301e4c23214b36067',
  "public/retail-admin/08-customers.js": 'bd982f04cce3d671381c84a427cea1ea63e572c8',
  "public/retail-admin/09-products.js": '9e1d70f14f4b800ee5a9acef42d9d5ea94a3cf24',
  "public/retail-admin/10-extras.js": '61045756b771cfbb50afe49a776b1f110f396119',
  "public/retail-admin/11-meituan.js": 'af4158b357843726de554f97fe2bd420fb9ba58b',
  "public/retail-admin/12-guanyi.js": '284ac575f01d8112192ed70e59a92394d0877d60',
  "public/retail-admin/13-activity.js": '24df879288267a5892ee610d7997d431afcee436',
  "public/retail-admin/14-eleme.js": '0d2940986be5b0cde3f3bd22b6fa6f86fc6b5856',
  "public/retail-admin/15-integrations.js": '67af59ef6b8e6784f29f58dd6bdfde2531903c7f',
  "public/retail-admin/16-purchasing.js": 'd775ed7623e634a5774392546accbd0d0b19d837',
  "public/retail-admin/17-setup-guide.js": '52a2bf25e789e592ac0446059d13bf766d3fea75',
  "public/saas-admin.html": '1cb98e9ce6218b87a72505bec438d51f28ceb06c',
  "public/shop.html": '8c84e7710c4f07d1236fd1eca8999bc99fe43eb3',
  "public/shop/_gallery.fixtures.js": '9cd5d7becfb5d96ac2f276d503cf6a7b65612b24',
  "public/shop/_gallery.html": 'ad653d21f3366dc7e93b70df60f9c404947d5658',
  "public/shop/_gallery_frame.html": 'e829fd800a08b74621f1c9fc900843da6f8d4095',
  "public/shop/_mockups.html": 'b32c9b2d5f3877849e61c03c41525624eb708375',
  "public/shop/blocks.css": '539b7ebe5c87f6b18b22e04def0e5f76ec15e3a2',
  "public/shop/blocks.js": '2e9e752e4079ca572659e9635056b333a4586876',
  "public/shop/product-blocks.css": '94ffbd20e5e088db1dc7e7eb20db1cb573d669ce',
  "public/shop/product-blocks.js": 'ed2aaf42ba3621a3de663a544c5046e5022bcd0c',
  "public/stock-icon.svg": '3ea42848c69fd6079cebe06e38afeddbf1810546',
  "public/stock-manifest.webmanifest": 'fa31669065acc207cda0fd6a90c1892c38559aa5',
  "public/stock.html": '7e1783f3ae1620fe26918f5c56de5e07e58837da',
  "public/store-admin.html": '521282047ed7e906dffdfc815ae9b87741b832f1',
  "public/storefront.html": '06096448a17ee5e9b652283863e2ee8df54cd13c',
  "public/sw.js": '808b024e34a221e332eb4e698f1efbed09c4bcd6',
  "public/tacet-dialogs.js": '30e404c5be3c51a523777bd9bd005501e62688f1',
  "public/tacet-favicon.svg": '960020f8858f89edb0505b00e4e020445c960718',
  "public/td-datetime.js": 'e9d62372b3727689f2ba9a3c132f8dd83f9265d2',
  "routes/admin.js": '50b276ee5756336b8bb681d25517158302bc033b',
  "routes/ai.js": 'c26fea7b39a74aefb55705891f8c16e8de59a37e',
  "routes/alerts.js": '6020c16e22df257bb260fbffbadc5c98fc992384',
  "routes/auth.js": '791ff03a111c69173d5d696b54a8530920173878',
  "routes/backend-auth.js": '8b879b049bd8efae41374377ee9ed82e456f42a5',
  "routes/backend-notices.js": 'dac44d0633a9a0fda2d2b1f0ff806792befbf0ed',
  "routes/backend-signup.js": '8c08594abd54234fdd81a5a69fd4284fefe7e526',
  "routes/backend-team.js": '3ab82c498195a25791a67f550d4780c3899c830a',
  "routes/billing-pay.js": '2ac36dd7b14852a399b1c9f462c537e13f273ecd',
  "routes/billing.js": 'd85b1e7a5da1eea34c8ec14c22e31d5ee6ed925a',
  "routes/eleme-admin.js": '03425fd05d6db64fea4249dbab44c4cd2178831b',
  "routes/eleme-internal.js": '4e8e6b4c8397cc4cc8e00c862b3a936de050a8a2',
  "routes/events.js": '193a1b0f6560c21770a1ddf0d693afd3dd7aee9b',
  "routes/feedback.js": '551a7fa472a50a9853db80b00598a698180c70ad',
  "routes/finance.js": '9232919fb7333c8fd445ec95ea7e3c985ee353dc',
  "routes/guanyi-admin.js": '119544ac210903f3d83dc3c3f1919dfdc93ed9a5',
  "routes/ingredients.js": 'c6641726a98e52c22843cbcabb2717ee2c545a50',
  "routes/integrations-admin.js": '7730f3ed59bdb5b23f0f1e4190ffa0d17fa5ef18',
  "routes/kitchen.js": '4643c73f09bd9782ad62a4bdf48ebc2af5462553',
  "routes/lookups.js": '18487b708bd15d6299bee36bc5ca38396a815be6',
  "routes/markets.js": '05aa736686a5e3e66a4d49488f76881f98f2219b',
  "routes/meituan-admin.js": 'a92f7afb798387df09a4785436a26e1983209c6d',
  "routes/meituan-internal.js": 'a91e7eeffaa82f6c325c2e4f6014802210cb6fb9',
  "routes/pos.js": '676d3e1a152f23040b427ba52bf74dab400863f2',
  "routes/production.js": '70de5470845688c564251a4d8b0b003881f98116',
  "routes/products.js": 'b225644c5cffbfc6eac5c6093ae87cc332246348',
  "routes/purchases.js": '3a2824bcf2693c750c7c74368d5796e4f951d1e7',
  "routes/push.js": '568514986f5b20f36ee8aa3d64fc10700797f8d3',
  "routes/recipes.js": '642b9154a9897c86dcb57bd95318d003403107f2',
  "routes/restock.js": 'd023fcce76ca78edc546c808e7ea146567b7876c',
  "routes/retail-inventory.js": 'ae34b8734b681518719b7152edae0705ad4a04f8',
  "routes/retail-page-templates.js": 'bd8782806bf36a3b86aff74e91ea9654cc3b9161',
  "routes/retail-purchasing.js": 'ec40fc0bba21c1c03f02bdcb34ab8e6f2eedb07c',
  "routes/retail-setup.js": 'a4c48e135e71f97f4afac6e51c77a06a6d5d400a',
  "routes/retail.js": 'fffe047b04921286a1be368f9918fd476501bad9',
  "routes/saas-admin.js": '48969e577551c4d92d80b52704767264361cc007',
  "routes/sales.js": '44d2c1a617ac2bd9f467a9f9d84c5c8a957d817d',
  "routes/store-admin.js": 'e552b5132c9fa42c8aa1a6bc8333bb1a14d49ecc',
  "routes/waste.js": '83c17c91b9497898097256c83ad6cae689bc7793',
  "schema.sql": '77163adbe717f2add68a0e9182c52650ef144849',
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
  "scripts/check-tenant-als.js": 'ca68bb41ba4b679b5ee2986e96496dca794b2dfb',
  "scripts/clear_stuck_refund_R260618156719.js": 'f4e3bf0fb97b25c59c154581640a32bbca19d9cc',
  "scripts/collapse_zones_into_default.js": '95141695ffc2261a968eed51190ad9282cb96a3d',
  "scripts/compliance_edits.json": 'a3411473eae31950e7c9e485048961e11c03ce73',
  "scripts/consolidate_guangdong_and_hk.js": 'e5fc692235bd9986fffb66cea7dac77e5abecc08',
  "scripts/convert_gzgrocery_xlsx.js": '9bf58f03996098001ba006adc187d7486f202033',
  "scripts/convert_meituan_xlsx.py": '4bb104a2410413c085dab474f0e286bde219e576',
  "scripts/copy_hummus_extras.js": '269a54f08b28b3a7e2776a29f026a3fed42b8536',
  "scripts/copy_soup_options.js": '0c109115abd8aac1cdb5390d5b522e3af3bbfd36',
  "scripts/db-backup.sh": '617b33eb28426f98ec11a9c935eaa8b825fd05a8',
  "scripts/db-seam-coverage.js": 'a3ce3265fe58bb83793b06c431cced61837733d3',
  "scripts/dedupe_province_covered_cities.js": '2a15ea6a400d9a7d2b98f89ad8f53e505535c55a',
  "scripts/deploy-apply.sh": 'eff96d52f45d507c42cf38f119bed69dd4f29b9b',
  "scripts/deploy-changed.sh": 'a52f9e929dff887a11a91c9117258a6f3784e84a',
  "scripts/diagnose_addon_stock_misses.js": '1ff3f1e3fd84a160270528c7cbd2e11853e16186',
  "scripts/diagnose_doubled_address.js": 'f09e82dc0b5e7134dd8ff2ef2ef57791251663d6',
  "scripts/diagnose_fallback_store.js": '6917e9f319e5537151c05028242f105ae4c5f734',
  "scripts/diagnose_guanyi_errors.js": 'a2e9a26d6f44926662626731ba755dd75aa97d4f',
  "scripts/diagnose_gzgrocery_stock.js": '125ffab5f9d136678701cc272c225ffe6f655832',
  "scripts/diagnose_money_unit_mixing.py": 'dd89177db12b74bd3365cfc17d7afc0b48c038ac',
  "scripts/diagnose_money_unit_split.js": '98e3142159747c24be58dc123b63cf21020c98d5',
  "scripts/diagnose_seam_batch.js": '0ffd64fbd1401b7b0aa58716214b1f2856d3a593',
  "scripts/diagnose_shipdistrict_orders.js": '437b09d73e37ae6ec6f756b1583a38561fa828b5',
  "scripts/diagnose_stock_shortage.js": '366a2b6958f8d816829d97936584fe1412b96575',
  "scripts/diagnose_store_hours_seam.js": '8afee8135b9a0382b834969fa5933b2ed36ce31c',
  "scripts/diagnose_tenant_step_a.js": '07a14911562ed156bc3be2fd7e2a78645af304a3',
  "scripts/diagnose_tenant_step_b.js": '73e8b216a47759086c4b32149821bbb3e0e87680',
  "scripts/diagnose_variant_descriptions.js": '595919b9ae938f45089234645967f0899e81a130',
  "scripts/dump_catalog_text.js": '5011a574fa870750ef2fd40a4dd7309ced2eb17f',
  "scripts/eleme-daemon.js": '12b25223d918526a4cb9b80d6a7fd961850e494d',
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
  "scripts/guanyi-daemon.js": '0b20504e61ff627efccbb95e84932957e8e2de5c',
  "scripts/guanyi-login.js": 'ba63934db19c297e0aee870776b154aa534538c4',
  "scripts/guanyi-pickup-report.js": '040e69c929202252f213fdd2d77918f051243668',
  "scripts/guanyi-probe-orders.js": 'f51ca562844b3708e80cba7d2c7b4aa21be8d7f2',
  "scripts/guanyi-probe-orders2.js": '560ebb1aee20a971bdde840aeefadbc88b6fd84c',
  "scripts/gzgrocery-order-daemon.js": '2ae02cbc40d0a0681643d316d49d98be4669bf28',
  "scripts/gzgrocery_import.json": '3e83ff17ee9fdae8374e2d1bc4ccfa24d6945604',
  "scripts/health-watchdog.js": '2207780664740c195b496df977f24e0ba8f9ddf8',
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
  "scripts/meituan-apply-catalog-changes.js": 'b9bb4b6b6407e2fda1dd602cf9a2f75fe593a4e5',
  "scripts/meituan-capture-stockwrite.js": '3cd9ae149e3795cd2370c2a8847a6a79e09b1f2e',
  "scripts/meituan-daemon.js": 'a0366e6d6a7f6c45df2ff1f76c33b297d50aa2d2',
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
  "scripts/post-commit.hook": '2c687238e1c1f136c60399cf8f6fa4eff21cf6a3',
  "scripts/postgres-full-copy/.gitignore": '063bb507493b1a9fd755ed5cdaaad2f77c4bb28b',
  "scripts/postgres-full-copy/README.md": '3b29e05c4c61b2f5915f9d92c750a874c3ba8243',
  "scripts/postgres-full-copy/census.py": 'af0659051e846e177a4248473dcf10f5f6500e08',
  "scripts/postgres-full-copy/checks.py": 'c9bd309316814a54249e45d1b946dcae3bcf1aec',
  "scripts/postgres-full-copy/copy_order.json": '6c0f7ff7cfbdb82589456fb8830d3c75cf1cf14b',
  "scripts/postgres-full-copy/drift.sh": '6bdc270b799498d5a035ac133e3fb23d40feaf08',
  "scripts/postgres-full-copy/drift_proof.py": '6974962ea7c2f4bc245c7d9a5826f4a6df841360',
  "scripts/postgres-full-copy/final.py": '93d801114e3755a757ebbcedc7e508a97280b285',
  "scripts/postgres-full-copy/gen.py": '0503726aaa2152065125043e8f68d28a6d276682',
  "scripts/postgres-full-copy/money.py": '745a8c232752ecf5fd406f59875c2ae00d6be795',
  "scripts/postgres-full-copy/money2.py": 'fab47625921d0e21b012b7c4a03c472d3269e099',
  "scripts/postgres-full-copy/money3.py": '2548650e377f875fe8bb810ebd2acddddbcbc466',
  "scripts/postgres-full-copy/overrides.py": 'b1801f25adf75d2a3462faf7eb793e5ba8b194ce',
  "scripts/postgres-full-copy/plan.json": 'c629df88aa603c4c0e32ca7733f7f0d418a8cff4',
  "scripts/postgres-full-copy/precision.py": '6b09b1b61a79ddb208a68b189235f342f5eab7d7',
  "scripts/postgres-full-copy/preflight.py": '6e2814356afcca907f7f6a818db1aebb54e62a3f',
  "scripts/postgres-full-copy/report_timings.py": '61c7e6f199816a68dc13c8d11ad35a03dc21efbe',
  "scripts/postgres-full-copy/run.py": '31636a5bac1600c3ae6e1cd99cc0b25a7260d19a',
  "scripts/postgres-full-copy/setseq.py": 'cb882008292d80dd088f7da5b19c096d0437bfe4',
  "scripts/postgres-full-copy/survey_pg.sql": 'cd8a0aef80b92b1c72b27477b4f6339ae7961877',
  "scripts/postgres-full-copy/survey_sqlite.py": 'b69b9e655bc7e2273ff0d435702c5b581e1bd747',
  "scripts/postgres-full-copy/verify.py": '0f730e8c058e1c2570d83d2cbc0f1fe9d19f4f56',
  "scripts/postgres-full-copy/volume.py": 'fbcfca963e7db390984b9b6f890fce402451b38e',
  "scripts/postgres-migration/README.md": '93b191367121215857e42f308dadf0612b092fe5',
  "scripts/postgres-migration/gen_accounts_sql.py": '579a7434ea5443695637d8cd37b387d79a9621c4',
  "scripts/postgres-migration/gen_migration_sql.py": 'ff7f7c0cc056955aaa667017ec80135aab0c956a',
  "scripts/postgres-migration/verify_accounts.py": 'b9f2b96412d9e22bc39b37361de0636fa9d6294e',
  "scripts/postgres-migration/verify_migration.py": 'eea0110adcb2afd636c323d79d446998ec3355c2',
  "scripts/products_import.json": '4abc4ced348e33729004b3f9cf40ba7bbdbd5401',
  "scripts/proxy-watchdog.js": 'e8d53110a812146425818b2d41d68e6878efed55',
  "scripts/qingyun-chrome.js": '6e364799480b495a032021f4678414bb4854822d',
  "scripts/qingyun-daemon.js": '089d993130d50219741a460e15351ff9594321be',
  "scripts/regions-curated-en.json": '04038694dec0180765da8384e7864c369c199206',
  "scripts/render_flash_mocks.py": 'f4e790871f9856a6e35aadccb3b74fc61b99e3af',
  "scripts/render_voucher_mocks.py": 'e5418695670751c6c77a017310a2d069c8577d98',
  "scripts/repair_guanyi_false_pickup.js": 'f18687362dcfa2237267f8c4a1e15de43046961f',
  "scripts/requeue_guanyi_errors.js": '32e6334ad4e207dffd92a2575c856cbeed93272b',
  "scripts/reset_test_orders.js": 'c500ae66197133be88c72a743be65942d487fa2c',
  "scripts/restore-test.sh": '8acaa55242a4bf9763a70d4373d166942cb2210a',
  "scripts/restore_recipe_data.js": 'e1ad9d6722478c1947ad5c8b3c3a2e069c9a2916',
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
  "scripts/shangou-daemon.js": 'c906c552ab4511576945b438c873be665b4914a6',
  "scripts/shangou-export-session.js": 'ae9d791abfd829c253c79a5dce1f8ddd11385024',
  "scripts/shangou-inject.js": '83ab77b72466bd8df1f7aa7165ef23f9a3ba927e',
  "scripts/shangou-map-seed.js": '9cf4c722f0579a028805b26027164a8550e9d07d',
  "scripts/shangou-order-sniffer.js": 'eebaab9f8bb8bb51628ae139c020cb756a018572',
  "scripts/shangou-status-read.js": 'c2f3c82c827f964ec97b6fdc1bc07e3f3ac4a56d',
  "scripts/shangou-status-recon.js": '197a1f1a769d238d945b694b8378bf4b071b52ff',
  "scripts/ship.sh": '77817db52dbb0c9f88f06140c0072995981c587c',
  "scripts/shrink_home_media.js": '58999ab58b61924e99351058d0a77bdb1f887f0e',
  "scripts/shrink_store_images.js": '6c5daadc3aa57465ad9fb48c99907fe2aa6112a2',
  "scripts/split_retail_js.js": 'd34d4fe6f0042386512290116608800b72fea569',
  "scripts/strip_weight_from_variant_names.js": '8de45110f5c9b0a5558c1d6b413d660572bfa800',
  "scripts/suggest_gzgrocery_aliases.js": '6015f9f851f58bed8a893a81726d1c5b619b8394',
  "scripts/sync_home_cn.js": 'ecb7c8e99cf5bad8caadf18f1df1b7ff4d28c63a',
  "scripts/td-datetime-check.js": 'e0119702d87670321829a322119dc72d8419cfdc',
  "scripts/test-deploy-base.sh": 'ac2c6d66dd7fb909970e56ef52584e424b0baefc',
  "scripts/test-fulfillment-reroute.js": '1fc9b2856a22cf94e20759cf94e1fbf289bb9a1e',
  "scripts/test_brand.js": 'd69e937c60520f51c5a453c16cf5796ca58793ed',
  "scripts/test_retail_local.js": 'a7269dff23b862e65024a7df03208f122b04a04d',
  "scripts/test_retail_local.py": '2310ffcd2155ebe41cd0d4a6314f0b1b38954499',
  "scripts/update_sh_bj_zones.js": '7fed6beca01e3974662ca9a904293c415b7d43c9',
  "scripts/verify-closed-store-routing.js": '41c6b0cc4a8a4156bc96b2696d58a39bbed15c3d',
  "scripts/verify-fulfilment-types.js": '2182eb26dbf9b9da3019fdd880c846ec2f99898d',
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
  "scripts/wizard_mock_desktop.html": '19456a2243a8f21931ec1c447375a9bd345094e2',
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
  "server.js": 'd74029d6a90aa4c04d9ede530d85a922d0e0cd8f',
};

main();
