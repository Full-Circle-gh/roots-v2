#!/usr/bin/env node
// Push the current branch to origin after a local commit (post-commit hook).
// Commit is already saved locally; push failure never blocks or undoes it.

const { spawnSync } = require('child_process');

function git(...args) {
  return spawnSync('git', args, { encoding: 'utf8' });
}

const branch = (git('rev-parse', '--abbrev-ref', 'HEAD').stdout || '').trim();
if (!branch || branch === 'HEAD') {
  console.log('[push] detached HEAD — nothing to push.');
  process.exit(0);
}

console.log(`[push] pushing '${branch}' to origin…`);
const push = spawnSync('git', ['push', 'origin', `HEAD:${branch}`], { encoding: 'utf8' });
if (push.stdout) process.stdout.write(push.stdout);
if (push.stderr) process.stderr.write(push.stderr);

if (push.status === 0) {
  console.log('[push] GitHub updated.');
} else {
  console.warn('[push] WARNING: push failed (offline/auth?). Commit is safe locally; run `git push` later.');
}
process.exit(0);
