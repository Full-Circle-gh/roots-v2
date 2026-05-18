// Release-announcement push. On every boot we read release.json and check
// the _migrations table to see if the listed version has already been
// announced; if not, fire a push to every subscribed user with the
// "What's new" body, then mark it announced so we don't repeat-fire on
// subsequent restarts.
//
// Deploy flow:
//   1. Edit release.json — bump `version` to a new string, write the
//      summary of what's new.
//   2. scp the updated files (including release.json) to the server.
//   3. pm2 restart roots-v2.
//   4. On boot, the boot hook below fires the push automatically.
//
// If the push system is disabled (no VAPID keys) the function is a no-op.
// We mark the version as announced even when sendPushToAll returns 0 sent
// — point is to track "we tried", not "everyone received". Otherwise a
// fresh install with no subscribers would re-fire forever.

const fs = require('fs');
const path = require('path');
const db = require('./database');
const _push = require('./routes/push');

const RELEASE_FILE = path.join(__dirname, 'release.json');

function announceLatestRelease() {
  if (!_push || !_push.ENABLED) {
    console.log('[releases] push disabled — skipping announcement');
    return;
  }
  let release;
  try {
    if (!fs.existsSync(RELEASE_FILE)) return;
    release = JSON.parse(fs.readFileSync(RELEASE_FILE, 'utf8'));
  } catch (e) {
    console.warn('[releases] read failed:', e.message);
    return;
  }
  if (!release || !release.version) return;
  const key = 'release_announced_' + release.version;
  try {
    db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    if (db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(key)) return;
    // Mark first so we don't double-fire on a fast subsequent restart.
    // If the push itself fails (network etc.) the message is dropped —
    // acceptable trade-off vs. spamming users on every restart loop.
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(key);
  } catch (e) {
    console.warn('[releases] mark-announced failed:', e.message);
    return;
  }
  const payload = {
    title: release.title || '🆕 系统已更新 · System updated',
    body:  release.summary || 'A new version is available — refresh the app to load it.',
    url:   release.url || '/',
    tag:   'release-' + release.version,
    requireInteraction: false,
  };
  _push.sendPushToAll(payload)
    .then(r => console.log('[releases] announced ' + release.version + ':', r))
    .catch(e => console.warn('[releases] push failed:', e.message));
}

module.exports = { announceLatestRelease };
