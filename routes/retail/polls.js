// Polls and voting — the "Your say" page in the mini app and the Voting tab in
// the admin. Moved out of routes/retail.js unchanged (decisions §470); the
// code below the line is byte for byte what it was there.
//
// HOW THIS FILE IS WIRED. routes/retail.js mounts it with
//   router.use(require('./retail/polls')({ requireRetailAuth, requireRetailAdmin, withConfigHistory }))
// at the spot this section used to start, so express tries these endpoints in
// the same order it always did. Those three helpers still live in retail.js and
// are handed in rather than required: retail.js is still loading when it
// requires this file, so `require('../retail')` here would come back empty.
// Anything from lib/ or middleware/ is required directly, as retail.js does.
//
// scripts/test_retail_split_routes.js holds this file to its twelve endpoints
// and fails if one of them could answer a request an endpoint left in
// retail.js also answers.

const express = require('express');
const { logActivity } = require('../../middleware/auth');
const { tdb } = require('../../lib/tenant-db');
const { withTransaction } = require('../../lib/db-transaction');

const router = express.Router();

// Filled by the mount call at the bottom. The pass-throughs below are what the
// endpoints are registered with, so they exist before anything is handed in.
const deps = {};
const requireRetailAuth  = (req, res, next) => deps.requireRetailAuth(req, res, next);
const requireRetailAdmin = (req, res, next) => deps.requireRetailAdmin(req, res, next);
const withConfigHistory  = (req, keys, write) => deps.withConfigHistory(req, keys, write);

// ────────────────────────────────────────────────────────────────────────────
// ─── Voting / community polls ───────────────────────────────────────────
// Mini-app design page #23. Customers vote one option per poll, earn
// `reward_points` (default 5) once per (poll, customer). Admin builds and
// closes polls from the retail-admin Voting tab.

// Editable intro tagline shown under the "Your say" headline. Stored in
// `storefront_config` under `voting.config`; the mini app reads it live (no
// republish needed). `{pts}` in the text auto-fills from the featured poll's
// reward_points. Defaults mirror the original hardcoded mini-app copy.
const VOTING_DEFAULTS = {
  intro_en: 'Every poll closes Sundays. Voting earns {pts} pts.',
  intro_cn: '每周日截止,投票得 {pts} 积分。',
  // When false, the mini app hides vote tallies and percentages — it still
  // marks the leading/winning option, just without any numbers.
  show_counts: true,
};

function loadVotingConfig() {
  const row = tdb().prepare("SELECT value_json FROM storefront_config WHERE key = 'voting.config'").get();
  if (!row) return { ...VOTING_DEFAULTS };
  let parsed;
  try { parsed = JSON.parse(row.value_json); }
  catch { parsed = {}; }
  const merged = { ...VOTING_DEFAULTS, ...(parsed || {}) };
  merged.show_counts = merged.show_counts !== false; // default on; only an explicit false hides counts
  return merged;
}

function loadPollOptions(pollId) {
  return tdb().prepare(
    `SELECT id, label_en, label_cn, color_hex, image_url, sort_order, votes
       FROM retail_poll_options
      WHERE poll_id = ?
      ORDER BY sort_order, id`
  ).all(pollId);
}

// Inflate cached vote counts for CUSTOMER DISPLAY ONLY. The real ledger
// (retail_poll_votes) and the stored counts (option.votes / poll.total_votes)
// are never changed — the admin Voting tab keeps showing the true numbers.
//
// `display_min_total` is a floor on the vote count customers see. When real
// turnout is below it, we scale every option by the SAME factor, so the ratio
// between options (and therefore every percentage + bar width) is identical —
// only the numbers grow. Once real votes exceed the floor, factor=1 (we never
// shrink genuine turnout). With 0 real votes there's no ratio to preserve, so
// we leave it at 0 rather than invent a split. Mutates `poll` in place.
function applyPollDisplayBoost(poll) {
  if (!poll) return poll;
  const floor = Math.max(0, parseInt(poll.display_min_total, 10) || 0);
  const opts = poll.options || [];
  const realTotal = opts.reduce((s, o) => s + (o.votes || 0), 0);
  if (!floor || realTotal <= 0 || floor <= realTotal) {
    // No boost — expose the true total (cached total_votes can drift; trust the
    // summed options) and tag the real total for any client that wants it.
    poll.real_total_votes = realTotal;
    poll.total_votes = poll.total_votes || realTotal;
    return poll;
  }
  const factor = floor / realTotal;
  let shown = 0;
  poll.options = opts.map(o => {
    const v = Math.round((o.votes || 0) * factor);
    shown += v;
    return { ...o, votes: v };
  });
  poll.real_total_votes = realTotal;   // backend/debug parity, ignored by UI
  poll.total_votes = shown;            // "N VOTES SO FAR" + percentage base
  return poll;
}

// Hydrate a poll row with options + caller's vote (if any). Customer-facing —
// applies the display-only vote boost (admin endpoints never call this).
function hydratePoll(poll, customerId) {
  if (!poll) return null;
  const options = loadPollOptions(poll.id);
  let myVoteOptionId = null;
  if (customerId) {
    const v = tdb().prepare('SELECT option_id FROM retail_poll_votes WHERE poll_id = ? AND customer_id = ?')
      .get(poll.id, customerId);
    if (v) myVoteOptionId = v.option_id;
  }
  return applyPollDisplayBoost({ ...poll, options, my_vote_option_id: myVoteOptionId });
}

// Customer-facing poll list — only `open` and `closed` polls (drafts hidden).
// Shared by the authed and public endpoints so both return an identical shape.
// `customerId` may be null (anonymous), which hydrates polls with no my_vote.
function listCustomerPolls(customerId) {
  const rows = tdb().prepare(
    `SELECT * FROM retail_polls
      WHERE status IN ('open', 'closed')
      ORDER BY
        CASE status WHEN 'open' THEN 0 WHEN 'closed' THEN 1 ELSE 2 END,
        is_featured DESC,
        sort_order,
        id DESC
      LIMIT 50`
  ).all();
  return rows.map(p => hydratePoll(p, customerId));
}

// Best-effort token → customer id. Never throws / never 401s — for endpoints
// that are readable anonymously but want to personalise when a token is sent.
function customerIdFromToken(req) {
  const m = /^Bearer\s+([A-Za-z0-9]+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const row = tdb().prepare(
    `SELECT c.id AS cid FROM retail_auth_tokens t
       JOIN retail_customers c ON c.id = t.customer_id
      WHERE t.token = ? AND datetime(t.expires_at) > CURRENT_TIMESTAMP
        AND c.is_blocked = 0`
  ).get(m[1]);
  return row ? row.cid : null;
}

// Customer-facing list — only `open` and `closed` polls (drafts hidden).
router.get('/api/retail/polls', requireRetailAuth, (req, res) => {
  res.json({ success: true, data: listCustomerPolls(req.customer.id) });
});

// Public, no-auth variant of the poll list. The web storefront
// (public/shop.html) is browsable anonymously — unlike the mini app, where the
// shopper is always signed in via WeChat — so a home `voting_block` (and the
// "Your say" page) needs a way to read live polls without a token. This is what
// lets ANY tenant's web storefront show its live poll, not just signed-in
// visitors. A valid token is still honoured when present, so a logged-in
// shopper sees their own vote + result bars; anonymous callers get the same
// polls with my_vote_option_id = null. Casting a vote still requires auth.
router.get('/api/retail/polls/public', (req, res) => {
  res.json({ success: true, data: listCustomerPolls(customerIdFromToken(req)) });
});

// Customer-facing voting config (editable intro tagline). Read live by the
// mini-app "Your say" page so staff can reword it without a republish.
router.get('/api/retail/voting/config', requireRetailAuth, (req, res) => {
  res.json({ success: true, data: loadVotingConfig() });
});

// Single poll detail — useful for share-link landing pages.
router.get('/api/retail/polls/:id', requireRetailAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const poll = tdb().prepare(
    `SELECT * FROM retail_polls
      WHERE id = ? AND status IN ('open', 'closed')`
  ).get(id);
  if (!poll) return res.status(404).json({ success: false, error: 'not_found' });
  res.json({ success: true, data: hydratePoll(poll, req.customer.id) });
});

// Cast a vote. Idempotent on (poll, customer) — second call returns the
// existing vote without double-awarding points.
router.post('/api/retail/polls/:id/vote', requireRetailAuth, express.json(), (req, res) => {
  const pollId   = parseInt(req.params.id, 10);
  const optionId = parseInt(req.body?.option_id, 10);
  if (!pollId || !optionId) return res.status(400).json({ success: false, error: 'bad_request' });

  const poll = tdb().prepare('SELECT id, status, reward_points FROM retail_polls WHERE id = ?').get(pollId);
  if (!poll) return res.status(404).json({ success: false, error: 'not_found' });
  if (poll.status !== 'open') return res.status(409).json({ success: false, error: 'poll_not_open' });

  const opt = tdb().prepare('SELECT id FROM retail_poll_options WHERE id = ? AND poll_id = ?').get(optionId, pollId);
  if (!opt) return res.status(400).json({ success: false, error: 'bad_option' });

  const existing = tdb().prepare('SELECT id, option_id FROM retail_poll_votes WHERE poll_id = ? AND customer_id = ?')
    .get(pollId, req.customer.id);
  if (existing) {
    // Already voted — return current state, do NOT re-award.
    return res.json({
      success: true,
      data: { already_voted: true, poll: hydratePoll(tdb().prepare('SELECT * FROM retail_polls WHERE id = ?').get(pollId), req.customer.id) },
    });
  }

  const reward = Math.max(0, parseInt(poll.reward_points, 10) || 0);
  const tx = tdb().transaction(() => {
    tdb().prepare(
      `INSERT INTO retail_poll_votes (poll_id, option_id, customer_id, awarded_points)
       VALUES (?, ?, ?, ?)`
    ).run(pollId, optionId, req.customer.id, reward);
    tdb().prepare('UPDATE retail_poll_options SET votes = votes + 1 WHERE id = ?').run(optionId);
    tdb().prepare('UPDATE retail_polls SET total_votes = total_votes + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(pollId);
    if (reward > 0) {
      tdb().prepare('UPDATE retail_customers SET points_balance = points_balance + ? WHERE id = ?')
        .run(reward, req.customer.id);
      const after = tdb().prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(req.customer.id).points_balance;
      tdb().prepare(
        `INSERT INTO retail_points_transactions (customer_id, delta, balance_after, source, note)
         VALUES (?, ?, ?, 'poll_vote', ?)`
      ).run(req.customer.id, reward, after, 'Poll #' + pollId);
    }
  });
  try { tx(); }
  catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.json({ success: true, data: { already_voted: true } });
    }
    throw e;
  }

  const updatedPoll = tdb().prepare('SELECT * FROM retail_polls WHERE id = ?').get(pollId);
  const updatedCust = tdb().prepare('SELECT points_balance FROM retail_customers WHERE id = ?').get(req.customer.id);
  res.json({
    success: true,
    data: {
      poll: hydratePoll(updatedPoll, req.customer.id),
      awarded_points: reward,
      points_balance: updatedCust.points_balance,
    },
  });
});

// ─── Voting · Admin ─────────────────────────────────────────────────────

// Editable intro tagline (EN/CN). Stored under `voting.config`; read live by
// the mini app, so a reword takes effect without a republish.
router.get('/api/retail-admin/voting/config', requireRetailAdmin, (req, res) => {
  res.json({ success: true, data: loadVotingConfig() });
});

router.put('/api/retail-admin/voting/config', requireRetailAdmin, express.json(), (req, res) => {
  const body = req.body || {};
  const next = {
    intro_en: String(body.intro_en || '').slice(0, 240) || VOTING_DEFAULTS.intro_en,
    intro_cn: String(body.intro_cn || '').slice(0, 240) || VOTING_DEFAULTS.intro_cn,
    show_counts: body.show_counts !== false,
  };
  withConfigHistory(req, ['voting.config'], () =>
  tdb().prepare(
    `INSERT INTO storefront_config (key, value_json, updated_at, updated_by)
     VALUES (?, ?, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = CURRENT_TIMESTAMP,
       updated_by = excluded.updated_by`
  ).run('voting.config', JSON.stringify(next), req.user.id));
  logActivity(req.user.id, req.user.username, 'update', 'voting_config', null, {}, req.ip);
  res.json({ success: true, data: next });
});

// Allowed status values (kept narrow so the UI's chip filters can map 1:1).
const POLL_STATUSES = new Set(['draft', 'open', 'closed']);

router.get('/api/retail-admin/polls', requireRetailAdmin, (req, res) => {
  const rows = tdb().prepare(
    `SELECT * FROM retail_polls
      ORDER BY
        CASE status WHEN 'open' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
        is_featured DESC,
        sort_order,
        id DESC`
  ).all();
  const out = rows.map(p => ({ ...p, options: loadPollOptions(p.id) }));
  res.json({ success: true, data: out });
});

router.get('/api/retail-admin/polls/:id', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const poll = tdb().prepare('SELECT * FROM retail_polls WHERE id = ?').get(id);
  if (!poll) return res.status(404).json({ success: false, error: 'not_found' });
  res.json({ success: true, data: { ...poll, options: loadPollOptions(id) } });
});

// Validate + normalize an options array from the admin form. Returns an
// array of clean { label_en, label_cn, color_hex, image_url, sort_order }.
function normalizePollOptions(rawOpts) {
  const arr = Array.isArray(rawOpts) ? rawOpts : [];
  const out = [];
  arr.forEach((o, i) => {
    const label_en = String(o?.label_en || '').trim().slice(0, 60);
    if (!label_en) return;                 // skip blank rows
    out.push({
      label_en,
      label_cn:   String(o?.label_cn || '').trim().slice(0, 60),
      color_hex:  String(o?.color_hex || '').trim().slice(0, 16),
      image_url:  String(o?.image_url || '').trim().slice(0, 500),
      sort_order: Number.isFinite(Number(o?.sort_order)) ? parseInt(o.sort_order, 10) : i,
    });
  });
  return out;
}

router.post('/api/retail-admin/polls', requireRetailAdmin, express.json(), async (req, res) => {
  const b = req.body || {};
  const question_en = String(b.question_en || '').trim();
  if (!question_en) return res.status(400).json({ success: false, error: 'question_required' });
  const status = POLL_STATUSES.has(b.status) ? b.status : 'draft';
  const options = normalizePollOptions(b.options);
  if (options.length < 2) return res.status(400).json({ success: false, error: 'need_at_least_two_options' });

  // Returns the new poll id out of the transaction — the response and the
  // activity log both need it, and it is only valid once the INSERT committed.
  const pollId = await withTransaction(tdb(), (tx) => {
    const r = tx.prepare(
      `INSERT INTO retail_polls
        (question_en, question_cn, explainer_en, explainer_cn, category_en, category_cn,
         status, closes_at, reward_points, is_featured, sort_order, display_min_total)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      question_en,
      String(b.question_cn || '').trim() || null,
      String(b.explainer_en || '').trim() || null,
      String(b.explainer_cn || '').trim() || null,
      String(b.category_en || '').trim() || null,
      String(b.category_cn || '').trim() || null,
      status,
      b.closes_at || null,
      Math.max(0, parseInt(b.reward_points, 10) || 5),
      b.is_featured ? 1 : 0,
      parseInt(b.sort_order, 10) || 0,
      Math.max(0, parseInt(b.display_min_total, 10) || 0),
    );
    const newPollId = r.lastInsertRowid;
    const insOpt = tx.prepare(
      `INSERT INTO retail_poll_options (poll_id, label_en, label_cn, color_hex, image_url, sort_order)
       VALUES (?,?,?,?,?,?)`
    );
    for (const o of options) {
      insOpt.run(newPollId, o.label_en, o.label_cn || null, o.color_hex || null, o.image_url || null, o.sort_order);
    }
    return newPollId;
  });
  logActivity(req.user.id, req.user.username, 'create', 'retail_poll', pollId, { question_en, status }, req.ip);
  const poll = tdb().prepare('SELECT * FROM retail_polls WHERE id = ?').get(pollId);
  res.json({ success: true, data: { ...poll, options: loadPollOptions(pollId) } });
});

router.put('/api/retail-admin/polls/:id', requireRetailAdmin, express.json(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const poll = tdb().prepare('SELECT * FROM retail_polls WHERE id = ?').get(id);
  if (!poll) return res.status(404).json({ success: false, error: 'not_found' });

  const b = req.body || {};
  const updates = {};
  const fields = ['question_en','question_cn','explainer_en','explainer_cn',
                  'category_en','category_cn','closes_at'];
  for (const f of fields) {
    if (f in b) updates[f] = (b[f] === '' || b[f] == null) ? null : String(b[f]);
  }
  if ('status' in b) {
    if (!POLL_STATUSES.has(b.status)) return res.status(400).json({ success: false, error: 'bad_status' });
    updates.status = b.status;
  }
  if ('reward_points' in b)  updates.reward_points = Math.max(0, parseInt(b.reward_points, 10) || 0);
  if ('is_featured' in b)    updates.is_featured   = b.is_featured ? 1 : 0;
  if ('sort_order' in b)     updates.sort_order    = parseInt(b.sort_order, 10) || 0;
  // Display-only vote floor: customers see at least this many votes (scaled to
  // keep the same ratio); the real ledger/counts are untouched. 0 = show real.
  if ('display_min_total' in b) updates.display_min_total = Math.max(0, parseInt(b.display_min_total, 10) || 0);
  if ('winner_option_id' in b) {
    const wid = parseInt(b.winner_option_id, 10);
    if (wid) {
      const own = tdb().prepare('SELECT id FROM retail_poll_options WHERE id = ? AND poll_id = ?').get(wid, id);
      if (!own) return res.status(400).json({ success: false, error: 'bad_winner_option' });
      updates.winner_option_id = wid;
    } else {
      updates.winner_option_id = null;
    }
  }

  // Options replace-all. Editing existing options renames them in place if
  // their id is sent back; otherwise we drop + reinsert. To keep this
  // simple AND preserve vote counts, only do a full reset when the caller
  // explicitly says `replace_options: true`. Otherwise we update labels /
  // colors / order on the existing rows by id.
  const incomingOptions = Array.isArray(b.options) ? b.options : null;

  // Defined here and run below, keeping the shape the old `const tx = ...` had.
  // Every statement takes the handle it is given, never tdb() — §24.
  const applyPollUpdate = (tx) => {
    if (Object.keys(updates).length) {
      const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      tx.prepare(`UPDATE retail_polls SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(...Object.values(updates), id);
    }
    if (incomingOptions) {
      if (b.replace_options) {
        // Hard reset — clears votes! Confirms required from the UI.
        tx.prepare('DELETE FROM retail_poll_options WHERE poll_id = ?').run(id);
        tx.prepare('UPDATE retail_polls SET total_votes = 0 WHERE id = ?').run(id);
        const normalized = normalizePollOptions(incomingOptions);
        const insOpt = tx.prepare(
          `INSERT INTO retail_poll_options (poll_id, label_en, label_cn, color_hex, image_url, sort_order)
           VALUES (?,?,?,?,?,?)`
        );
        for (const o of normalized) {
          insOpt.run(id, o.label_en, o.label_cn || null, o.color_hex || null, o.image_url || null, o.sort_order);
        }
      } else {
        // In-place edit / add — preserve vote counts on existing rows.
        const existingIds = new Set(tx.prepare('SELECT id FROM retail_poll_options WHERE poll_id = ?').all(id).map(r => r.id));
        const seenIds = new Set();
        const upd = tx.prepare(
          `UPDATE retail_poll_options SET
             label_en = ?, label_cn = ?, color_hex = ?, image_url = ?, sort_order = ?
           WHERE id = ? AND poll_id = ?`
        );
        const ins = tx.prepare(
          `INSERT INTO retail_poll_options (poll_id, label_en, label_cn, color_hex, image_url, sort_order)
           VALUES (?,?,?,?,?,?)`
        );
        incomingOptions.forEach((o, i) => {
          const labelEn = String(o?.label_en || '').trim().slice(0, 60);
          if (!labelEn) return;
          const labelCn = String(o?.label_cn || '').trim().slice(0, 60) || null;
          const color   = String(o?.color_hex || '').trim().slice(0, 16) || null;
          const img     = String(o?.image_url || '').trim().slice(0, 500) || null;
          const sortVal = Number.isFinite(Number(o?.sort_order)) ? parseInt(o.sort_order, 10) : i;
          const oid     = parseInt(o?.id, 10);
          if (oid && existingIds.has(oid)) {
            upd.run(labelEn, labelCn, color, img, sortVal, oid, id);
            seenIds.add(oid);
          } else {
            ins.run(id, labelEn, labelCn, color, img, sortVal);
          }
        });
        // Remove options the caller dropped from the form.
        for (const oldId of existingIds) {
          if (!seenIds.has(oldId)) {
            // Refuse to delete an option that has votes — admin must
            // either close the poll (winner pick) or hard-reset.
            const votes = tx.prepare('SELECT votes FROM retail_poll_options WHERE id = ?').get(oldId)?.votes || 0;
            if (votes > 0) continue;
            tx.prepare('DELETE FROM retail_poll_options WHERE id = ?').run(oldId);
          }
        }
      }
    }
  };
  // Await inside the try: the catch below is what keeps raw SQLite text out of
  // the response, and an await outside it would bypass the catch entirely.
  try { await withTransaction(tdb(), applyPollUpdate); }
  catch (e) {
    // Don't leak raw SQLite text to the client — log it, return a stable code.
    console.error('[poll update]', id, e);
    return res.status(500).json({ success: false, error: 'update_failed' });
  }

  logActivity(req.user.id, req.user.username, 'update', 'retail_poll', id, { updates: Object.keys(updates), replaced_options: !!(incomingOptions && b.replace_options) }, req.ip);
  const fresh = tdb().prepare('SELECT * FROM retail_polls WHERE id = ?').get(id);
  res.json({ success: true, data: { ...fresh, options: loadPollOptions(id) } });
});

router.delete('/api/retail-admin/polls/:id', requireRetailAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = tdb().prepare('DELETE FROM retail_polls WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ success: false, error: 'not_found' });
  logActivity(req.user.id, req.user.username, 'delete', 'retail_poll', id, null, req.ip);
  res.json({ success: true });
});

module.exports = function mountPolls(d) {
  for (const k of ['requireRetailAuth', 'requireRetailAdmin', 'withConfigHistory']) {
    if (typeof d[k] !== 'function') throw new Error('routes/retail/polls: ' + k + ' was not handed in');
  }
  Object.assign(deps, d);
  return router;
};
