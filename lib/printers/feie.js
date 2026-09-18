// Feie (飞鹅) adapter — the vendor this product started on, behind the common
// printer contract (decisions §171).
//
// THIS FILE IS A THIN WRAPPER AND IS MEANT TO STAY ONE. All the Feieyun
// transport — endpoint, sha1 signature, the 5000-byte content ceiling, the
// ret === 0 success test — lives in lib/feie.js and was not moved, because
// that file is also where every 58mm renderer lives and splitting it would
// have churned ~1090 lines of layout to relocate ~120 lines of transport.
//
// HOUSE MARKUP IS FEIE'S TAG SET, so this adapter translates nothing: it is a
// pass-through by construction, which is exactly why the tag set was chosen as
// the house vocabulary rather than a neutral form invented for the occasion.
// lib/printers/spyun.js is where a translation table actually looks like
// something.

'use strict';

const feie = require('../feie');

module.exports = {
  id: 'feie',
  label_en: 'Feie',
  label_cn: '飞鹅',
  credFields: [
    { key: 'user', env: 'FEIE_USER', label_en: 'Account (USER)',  label_cn: '账号',     secret: false },
    // NOT the 密钥/KEY on the device label — that one only binds the printer to
    // the account in the app. Same trap as Shangpeng's pkey.
    { key: 'ukey', env: 'FEIE_UKEY', label_en: 'USERKEY (UKEY)',  label_cn: '用户密钥', secret: true },
  ],
  enabled: feie.feieEnabled,
  printContent: feie.printContent,
  MAX_CONTENT_BYTES: feie.MAX_CONTENT_BYTES,
  BIG_WIDTH: feie.BIG_WIDTH,
};
