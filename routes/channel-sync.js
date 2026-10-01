'use strict';

// /api/retail-admin/channel-sync — one verdict per item per channel (§103),
// and since §117 part two the two repairs that page can make itself.
//
// THE READ feeds the Channel sync page, the dashboard row that counts it and
// the phone. All of it comes from lib/channel-sync-items.js, so no two of those
// surfaces can disagree.
//
// THE TWO WRITES are `push` (queue this item now) and `sync` (turn this item's
// sync on or off), for all three channels, from lib/channel-sync-write.js.
// §103 said "the three channel tabs stay the place a mapping is repaired" and
// that is still true of the repairs that need a channel's own catalogue picker
// — naming a listing, claiming a 规格. It stopped being true of these two, which
// every channel already implements identically underneath and which between
// them clear four of the seven reasons an item can need attention. The reason
// it changed is in §117: a page that can only report sends the operator
// somewhere else to act, and that was the whole complaint.
//
// Auth is the same gate the channel tabs use (requireRetailAdmin). The tab
// itself is gated any-of meituan:view / eleme:view / guanyi:view on the client
// (TAB_CAP in public/retail-admin/01-core.js), the same rule that admits the
// Sales page: an operator who may open any one channel screen may see which
// items that channel is wrong about.

const express = require('express');
const router = express.Router();
const { tdb } = require('../lib/tenant-db');
const { requireRetailAdmin } = require('./retail');
const { channelSyncItems } = require('../lib/channel-sync-items');
const channelWrite = require('../lib/channel-sync-write');

// ?compact=1     verdict + reason per channel only — what the Products list's
//                three dots draw, and nothing else.
// ?productId=N   just that product — what the product editor's Channels block
//                asks for. Repeatable, so a variant family is one request.
// ?channel=KEY   only that channel, with its per-store detail — what each of
//                the three channel TABS asks for, so a tab can mark the right
//                store's dot rather than a folded one. Comma-separated.
router.get('/api/retail-admin/channel-sync', requireRetailAdmin, (req, res) => {
  try {
    const raw = req.query.productId;
    const productIds = raw === undefined ? null
      : (Array.isArray(raw) ? raw : String(raw).split(','))
          .map(v => parseInt(v, 10)).filter(Number.isFinite);
    res.set('Cache-Control', 'no-store');
    const chRaw = req.query.channel;
    const channels = chRaw === undefined ? null
      : (Array.isArray(chRaw) ? chRaw : String(chRaw).split(',')).map(v => String(v).trim()).filter(Boolean);
    res.json({ success: true, data: channelSyncItems(tdb(), { productIds, channels, compact: req.query.compact === '1' }) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── The two writes ───────────────────────────────────────────────────────────
//
// Gated through lib/cap-routes.js like every other mutation: `push` answers
// {channel}:sync — it is the same verb as push-all, one item wide — and `sync`
// answers {channel}:map, because turning an item's sync off changes its MAPPING
// and that is what the channel's own /products/:id/map already answers.
// An unmapped path there fails OPEN, so a new write that is not in that file is
// a write with no gate at all; scripts/test_channel_sync_write.js holds both.

// The refusal an operator can act on. `not_mapped` and `not_syncing` are not
// server errors — they are the page being out of date, which happens when two
// people work the same list — so they come back 409 with a code the page turns
// into a sentence, rather than 500 with a stack trace's worth of nothing.
//
// `no_listing_name` (§325 S2j) is the same kind of answer: the mapping is not
// ready to be switched on, and the operator can fix it — name the listing on
// the Eleme tab. It names the stores whose mapping has no name.
function fail(res, r) {
  const status = (r.code === 'unknown_channel' || r.code === 'bad_product') ? 400 : 409;
  return res.status(status).json({ success: false, error: r.code, ...(r.stores ? { stores: r.stores } : {}) });
}

router.post('/api/retail-admin/channel-sync/:channel/products/:id/push',
  requireRetailAdmin, express.json(), (req, res) => {
    try {
      const r = channelWrite.pushNow(tdb(), req.params.channel, req.params.id);
      if (!r.ok) return fail(res, r);
      res.json({ success: true, ...r });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

router.post('/api/retail-admin/channel-sync/:channel/products/:id/sync',
  requireRetailAdmin, express.json(), (req, res) => {
    try {
      const { on, storeCode } = req.body || {};
      // The switch's position is the request. An absent `on` is a malformed
      // call, not "off": defaulting it would let a dropped field silently stop
      // a product syncing.
      if (typeof on !== 'boolean') {
        return res.status(400).json({ success: false, error: 'on must be true or false' });
      }
      const r = channelWrite.setSync(tdb(), req.params.channel, req.params.id, on, storeCode);
      if (!r.ok) return fail(res, r);
      res.json({ success: true, ...r });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

module.exports = router;
