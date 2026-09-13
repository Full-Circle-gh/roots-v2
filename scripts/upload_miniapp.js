#!/usr/bin/env node
/**
 * Upload the mini app straight from the repo — no WeChat Developer Tools GUI,
 * no local folder to keep in sync with GitHub. Run via scripts/upload-miniapp.ps1,
 * which does `git pull` immediately before this runs, so what gets uploaded is
 * always exactly what's on origin/main.
 *
 * Needs `miniprogram-ci` installed in scripts/miniapp-ci-tool/ (run
 * `npm install --prefix scripts/miniapp-ci-tool` once — upload-miniapp.ps1
 * does this for you automatically) — deliberately NOT a root devDependency.
 * It pulls an abandoned Babel 6 chain that has nothing to do with this app
 * and would otherwise show up in every session's and every CI run's own
 * `npm audit` on this shared repo for a tool only this script ever touches.
 *
 * Also needs a mini-program upload private key, which you generate yourself
 * and this repo never sees: mp.weixin.qq.com → 开发 → 开发管理 → 开发设置 →
 * 小程序代码上传密钥. That console page also assigns the key a "robot" number
 * (1–30) — pass the same number here with --robot.
 *
 *   node scripts/upload_miniapp.js --version 1.2.3 --key C:\keys\private.wxba....key --robot 1 [--desc "..."] [--appid wx...]
 *
 * NEVER commit the private key file. *.key and *.pem are already in
 * .gitignore for exactly this — don't add an exception for it.
 */
'use strict';

const path = require('path');
const fs = require('fs');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
    out[key] = next;
    i++;
  }
  return out;
}

function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.version) fail('--version is required, e.g. --version 1.2.3 (must be higher than the last uploaded version)');
  if (!/^\d+\.\d+\.\d+$/.test(String(args.version))) fail(`--version "${args.version}" must look like 1.2.3`);
  if (!args.key) fail('--key is required — path to your mini-program upload private key file');
  if (!args.robot) fail('--robot is required — the CI robot number (1-30) that key was generated for');

  const keyPath = path.resolve(String(args.key));
  if (!fs.existsSync(keyPath)) fail(`private key not found at ${keyPath}`);

  const ROOT = path.join(__dirname, '..');
  const projectPath = path.join(ROOT, 'miniapp');

  // ── The guard this script exists partly to enforce ─────────────────────────
  // docs/tacet-consolidation-decisions.md: the mini app is published with
  // EVERY file in the project — no build/upload step may drop a file its own
  // dependency graph thinks is unreachable. That decision cost a live blank
  // checkout on 2026-08-09 (utils/phone.js silently excluded). Refuse to
  // upload at all if either flag has been flipped back on, rather than trust
  // that whatever library version is installed still honours it correctly.
  const cfg = JSON.parse(fs.readFileSync(path.join(projectPath, 'project.config.json'), 'utf8'));
  if (cfg.setting && cfg.setting.ignoreUploadUnusedFiles === true) {
    fail('project.config.json has ignoreUploadUnusedFiles: true — this is the exact setting that caused the 2026-08-09 blank-checkout incident. Set it back to false before uploading. See docs/tacet-consolidation-decisions.md.');
  }
  const privateCfgPath = path.join(projectPath, 'project.private.config.json');
  if (fs.existsSync(privateCfgPath)) {
    const privateCfg = JSON.parse(fs.readFileSync(privateCfgPath, 'utf8'));
    if (privateCfg.setting && privateCfg.setting.ignoreDevUnusedFiles === true) {
      fail('project.private.config.json has ignoreDevUnusedFiles: true — same class of bug as ignoreUploadUnusedFiles. Set it back to false before uploading.');
    }
  }

  const appid = args.appid || cfg.appid;
  if (!appid || appid === 'wx0000000000000000') {
    fail('no real appid — pass --appid or fix miniapp/project.config.json');
  }

  // Resolved from its own isolated install, never the root node_modules —
  // see scripts/miniapp-ci-tool/package.json for why.
  const toolDir = path.join(__dirname, 'miniapp-ci-tool');
  let ci;
  try {
    ci = require(path.join(toolDir, 'node_modules', 'miniprogram-ci'));
  } catch (e) {
    fail(`miniprogram-ci is not installed. Run "npm install --prefix ${toolDir}" first (upload-miniapp.ps1 does this automatically).`);
  }

  const desc = args.desc || `Uploaded from ${ROOT} via scripts/upload_miniapp.js`;

  console.log(`Uploading ${projectPath}`);
  console.log(`  appid:   ${appid}`);
  console.log(`  version: ${args.version}`);
  console.log(`  robot:   ${args.robot}`);
  console.log(`  desc:    ${desc}`);
  console.log('');

  const project = new ci.Project({
    appid,
    type: 'miniProgram',
    projectPath,
    privateKeyPath: keyPath,
    ignoreDevFiles: false, // see the guard above — never let this drift to true
  });

  try {
    const result = await ci.upload({
      project,
      version: String(args.version),
      desc,
      robot: Number(args.robot),
      setting: {
        es6: true,
        es7: true,
        minify: true,
        minifyJS: true,
        minifyWXML: true,
        minifyWXSS: true,
        autoPrefixWXSS: true,
        codeProtect: false,
      },
      onProgressUpdate: (msg) => console.log(msg),
    });
    console.log('');
    console.log('✓ Upload finished.');
    if (result && result.subPackageInfo) console.log(JSON.stringify(result.subPackageInfo, null, 2));
    console.log('');
    console.log('This uploaded a new DRAFT version — it is not live yet. In');
    console.log('mp.weixin.qq.com → 版本管理: set it as the trial version (体验版),');
    console.log('test it on a real device, then submit for review and release it');
    console.log('to everyone once it is approved.');
  } catch (e) {
    fail('upload failed: ' + (e && e.message ? e.message : String(e)));
  }
}

main();
