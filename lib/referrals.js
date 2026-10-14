// Refer-a-friend: the programme's settings (read from storefront_config
// `affiliate.*`), the share title, and each customer's stable referral code,
// minted on first use. Moved out of routes/retail.js unchanged (decisions
// §477). The flow itself (apply a code, reward the first paid order) stays in
// routes/retail.js under "Affiliate / refer-a-friend".
'use strict';

const crypto = require('crypto');
const { tdb } = require('./tenant-db');
const { cfgValue } = require('./store-config');

const AFFILIATE_REWARD_DEFAULT = 20;       // ¥ per first paid order — mirrors the live stored value
const REFERRAL_CODE_PREFIX     = 'ROOTS-';
const REFERRAL_CODE_BODY_LEN   = 6;        // 6 alnum chars → ~36^6 ≈ 2B keyspace

function affiliateSettings() {
  // Single on/off: the platform feature toggle (admin Settings → Features),
  // mirrored in storefront_config as `features.affiliate` (default on). The
  // old standalone `affiliate.enabled` control was retired so customers + admin
  // never face two competing switches — the feature toggle is now the sole
  // source of truth for whether the referral program runs.
  return {
    enabled:        cfgValue('features.affiliate', true) ? true : false,
    // Referrer reward ("for you") — keeps the legacy `rewardPerOrder` key so
    // existing setups (and the per-row admin reward edit) keep working.
    rewardPerOrder: Number(cfgValue('affiliate.rewardPerOrder', AFFILIATE_REWARD_DEFAULT)) || 0,
    // Referee reward ("for them") — the invited friend's cashback, credited to
    // their wallet on their first paid order. Defaults to 0 (off) so enabling
    // the split is an explicit, opt-in spend decision by the operator.
    rewardReferee:  Number(cfgValue('affiliate.rewardReferee', 0)) || 0,
    // Lifetime revenue-share — a % of EVERY paid order the invitee places AFTER
    // their first, credited to the referrer's wallet as store credit. 0 = off
    // (default), so turning it on is an explicit, opt-in spend decision. The
    // first paid order stays the one-shot bounty's job (no double-pay). ONE LEVEL
    // only — see creditLifetimeCommission. Capped at 50% by the admin endpoint.
    lifetimeRatePercent: Number(cfgValue('affiliate.lifetimeRatePercent', 0)) || 0,
    // How long the lifetime share keeps paying, measured from when the friend
    // JOINED (referral_applied_at). 12 = one year (default), 0 = forever/no cap.
    // After the window closes the referrer simply stops earning on that friend's
    // future orders — nothing is clawed back.
    lifetimeMonths: Number(cfgValue('affiliate.lifetimeMonths', 12)) || 0,
    // WHO earns the ongoing share, once it is running at all. 'everyone' (the
    // default, and the behaviour every existing shop already has) = any
    // referrer earns it. 'selected' = only customers flagged
    // retail_customers.lifetime_eligible earn it; everyone else still gets the
    // one-time bounty, which is never mode-gated.
    //
    // This is DELIBERATELY independent of lifetimeRatePercent. The rate is the
    // on/off switch for the feature ("is the ongoing share running at all");
    // the mode sits underneath it and decides who it runs FOR. A shop in
    // selected mode at 5% is a real, storable state — reading the mode off a
    // zero rate would make it unrepresentable.
    lifetimeMode: cfgValue('affiliate.lifetimeMode', 'everyone') === 'selected' ? 'selected' : 'everyone',
    codePrefix:     String(cfgValue('affiliate.codePrefix', REFERRAL_CODE_PREFIX)),
    // Optional custom picture for the WeChat share card (the 5:4 thumbnail a
    // customer sees when they forward their invite into a chat). Empty string
    // ⇒ the mini-app falls back to the bundled default share-affiliate.png.
    // Stored as a relative media path (e.g. /api/retail/media/55); the
    // customer endpoint absolutizes it so the mini-app can hand WeChat a URL.
    shareImage:     String(cfgValue('affiliate.shareImage', '') || ''),
    // Optional custom title for the invite share card, per language. Empty
    // strings ⇒ the mini-app keeps its built-in reward-aware default. The
    // referral code always travels in the share path (?ref=), never the title,
    // so a custom title never breaks attribution.
    shareTitle:     normShareTitle(cfgValue('affiliate.shareTitle', null)),
  };
}

// Coerce a stored share-title value into a clean { en, cn } pair. Accepts a
// legacy plain string (treated as both languages) or a partial object; trims
// and caps each side. Empty/missing ⇒ { en: '', cn: '' } so callers can always
// read .en / .cn without guarding the shape.
const SHARE_TITLE_MAX = 60;
function normShareTitle(raw) {
  const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, SHARE_TITLE_MAX);
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { en: clean(raw.en), cn: clean(raw.cn) };
  }
  const one = clean(raw);
  return { en: one, cn: one };
}

// 6-char alnum (uppercase, no 0/O/1/I confusables). Re-rolled on collision.
function newReferralCodeBody() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < REFERRAL_CODE_BODY_LEN; i++) {
    s += alphabet[crypto.randomBytes(1)[0] % alphabet.length];
  }
  return s;
}

function ensureReferralCode(customerId) {
  const row = tdb().prepare('SELECT referral_code FROM retail_customers WHERE id = ?').get(customerId);
  if (!row) return null;
  if (row.referral_code) return row.referral_code;
  const prefix = affiliateSettings().codePrefix;
  for (let i = 0; i < 8; i++) {
    const candidate = prefix + newReferralCodeBody();
    try {
      tdb().prepare('UPDATE retail_customers SET referral_code = ? WHERE id = ? AND referral_code IS NULL').run(candidate, customerId);
      const fresh = tdb().prepare('SELECT referral_code FROM retail_customers WHERE id = ?').get(customerId);
      if (fresh.referral_code) return fresh.referral_code;
    } catch (e) { /* UNIQUE collision — retry */ }
  }
  return null;
}

module.exports = {
  AFFILIATE_REWARD_DEFAULT, REFERRAL_CODE_PREFIX, REFERRAL_CODE_BODY_LEN, affiliateSettings,
  SHARE_TITLE_MAX, normShareTitle, newReferralCodeBody, ensureReferralCode,
};
