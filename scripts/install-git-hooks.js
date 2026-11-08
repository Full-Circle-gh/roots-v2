#!/usr/bin/env node
// Copy tracked hook templates into .git/hooks (idempotent). Runs on npm install.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootResult = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
if (rootResult.status !== 0) {
  console.log('[hooks] not a git checkout — skip hook install.');
  process.exit(0);
}

const root = rootResult.stdout.trim();
const hooksDir = path.join(root, '.git', 'hooks');
const template = path.join(root, 'scripts', 'post-commit.hook');
const dest = path.join(hooksDir, 'post-commit');

if (!fs.existsSync(template)) {
  console.warn('[hooks] missing scripts/post-commit.hook — skip.');
  process.exit(0);
}

fs.mkdirSync(hooksDir, { recursive: true });
const body = fs.readFileSync(template, 'utf8').replace(/\r\n/g, '\n');
fs.writeFileSync(dest, body, { mode: 0o755 });

console.log('[hooks] post-commit installed → every local `git commit` auto-pushes to GitHub when online.');
