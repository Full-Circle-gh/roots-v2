'use strict';

// GET /api/retail-admin/channel-sync — one verdict per item per channel (§103).
//
// Read-only. The three channel tabs stay the place a mapping is repaired; this
// endpoint feeds the page that says WHICH items need repairing, the dashboard
// row that counts them, and the phone. All of it comes from
// lib/channel-sync-items.js, so no two of those surfaces can disagree.
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

module.exports = router;
