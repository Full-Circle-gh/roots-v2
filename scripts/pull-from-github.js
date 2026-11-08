#!/usr/bin/env node
// Pull latest from GitHub before you start work (local stays the working copy).
// Run via: npm run sync

const { spawnSync } = require('child_process');

function git(...args) {
  return spawnSync('git', args, { encoding: 'utf8' });
}

const branch = (git('rev-parse', '--abbrev-ref', 'HEAD').stdout || '').trim();
if (!branch || branch === 'HEAD') {
  console.log('[sync] detached HEAD — skip pull.');
  process.exit(0);
}

const remote = (git('remote').stdout || '').trim().split('\n').includes('origin')
  ? 'origin'
  : null;
if (!remote) {
  console.warn('[sync] no origin remote — skip pull.');
  process.exit(0);
}

console.log(`[sync] pulling ${remote}/${branch} (local first, then merge GitHub changes)…`);
const pull = spawnSync('git', ['pull', '--rebase', remote, branch], { stdio: 'inherit' });
if (pull.status !== 0) {
  console.error('[sync] pull failed — fix conflicts or run `git pull` manually.');
  process.exit(pull.status || 1);
}
console.log('[sync] local repo is up to date with GitHub.');
