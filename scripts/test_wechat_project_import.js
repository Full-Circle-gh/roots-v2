#!/usr/bin/env node
/**
 * WeChat Developer Tools must open either miniapp/ or the repo root. The root
 * project.config.json points miniprogramRoot at miniapp/ so app.json resolves.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, extra) => { fail++; console.log('  ✗ ' + m + (extra ? '\n      ' + extra : '')); };

const rootCfgPath = path.join(ROOT, 'project.config.json');
const miniCfgPath = path.join(ROOT, 'miniapp', 'project.config.json');
const appJsonPath = path.join(ROOT, 'miniapp', 'app.json');

if (!fs.existsSync(rootCfgPath)) {
  bad('project.config.json missing at repo root');
  process.exit(1);
}

const rootCfg = JSON.parse(fs.readFileSync(rootCfgPath, 'utf8'));
const miniCfg = JSON.parse(fs.readFileSync(miniCfgPath, 'utf8'));

const root = (rootCfg.miniprogramRoot || '').replace(/^\.\//, '').replace(/\/$/, '');
root === 'miniapp' ? ok('miniprogramRoot is miniapp/') : bad('miniprogramRoot must be miniapp/', rootCfg.miniprogramRoot);

const resolvedApp = path.join(ROOT, root, 'app.json');
if (fs.existsSync(resolvedApp)) ok('app.json resolves under miniprogramRoot');
else bad('app.json not found at ' + resolvedApp);
if (path.resolve(resolvedApp) === path.resolve(appJsonPath)) ok('resolved path is miniapp/app.json');
else bad('miniprogramRoot does not point at miniapp/', resolvedApp);

rootCfg.compileType === 'miniprogram' ? ok('compileType is miniprogram') : bad('compileType must be miniprogram', rootCfg.compileType);
rootCfg.appid === miniCfg.appid ? ok('root appid matches miniapp/project.config.json') : bad('appid drift between root and miniapp configs');

const ignoreUpload = rootCfg.setting && rootCfg.setting.ignoreUploadUnusedFiles;
ignoreUpload === false ? ok('ignoreUploadUnusedFiles is false at repo root') : bad('ignoreUploadUnusedFiles must be false at repo root', String(ignoreUpload));

console.log('');
if (fail) {
  console.log(`FAIL ${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`OK ${pass} passed`);
