#!/usr/bin/env bash
# make_safe_db_copy.sh — the ONLY sanctioned way to make a copy of roots.db.
#
# WHY THIS EXISTS
# ---------------
# On 2026-08-23 a proof harness copied data/roots.db to a scratch tree, loaded
# lib/ops-alert.js against it, and sent THREE REAL MESSAGES to the live ops WeCom
# group. Nothing was wrong with the harness except that it copied the database,
# and the database carries the webhook.
#
# THE RULE THAT COMES OUT OF IT: COPYING PRODUCTION DATA COPIES ITS OUTBOUND
# CHANNELS. A copy exists to be safe to break. It is not safe to break while it
# still knows how to reach the outside world.
#
# WHAT IS SEVERED, AND THE PRINCIPLE BEHIND THE CUT
# -------------------------------------------------
# Credentials and endpoints, not data. You cannot text a customer without an SMS
# secret, and you cannot print without a printer key — so cutting the CHANNELS
# neutralises every outbound path while leaving the rows intact and the copy
# actually useful. Push endpoints are the exception: an endpoint IS the channel,
# with no credential in front of it, so those are cleared as data.
#
#   storefront_config   both WeCom webhooks (system alerts AND the order group),
#                       Aliyun SMS secret, Feie printer ukey, JD app/access
#                       credentials, KD100 key/secret/callback, customer-service
#                       phone and URL
#   tenant_secrets      every stored secret value
#   tenant_integrations every stored credential blob
#   eleme_tokens        access/refresh tokens
#   *_auth_tokens,      live session and impersonation tokens: a copy holding
#   oauth_states        these can act as a signed-in user against production
#   push_subscriptions  the endpoint IS the channel
#   operator push subs  same
#
# It does NOT blank customer phones, emails or addresses. Those are PII and they
# matter, but they are not a way OUT: with every credential above severed there
# is nothing left to send through. If a copy is leaving this box, that is a
# different question and this script is not the answer to it.
#
# IT VERIFIES AND REFUSES. The blanking is asserted afterwards against the copy,
# and a copy that still holds a channel is DELETED rather than handed back — a
# half-neutered copy is worse than none, because it looks safe.
#
# USAGE
#   scripts/make_safe_db_copy.sh /tmp/scratch/data/roots.db
#   scripts/make_safe_db_copy.sh /tmp/scratch/data/roots.db --from /path/to/src.db

set -euo pipefail

DEST="${1:-}"
SRC=/root/roots-v2/data/roots.db
if [ "${2:-}" = "--from" ] && [ -n "${3:-}" ]; then SRC="$3"; fi

if [ -z "$DEST" ]; then
  echo "usage: $0 <destination.db> [--from <source.db>]" >&2
  exit 2
fi
if [ ! -f "$SRC" ]; then
  echo "REFUSED: no source database at $SRC" >&2
  echo "  (after F1 the live file is renamed — pass --from explicitly if that is what you mean)" >&2
  exit 2
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "REFUSED: sqlite3 is not installed, so this cannot neuter the copy." >&2
  echo "  A copy it cannot neuter is a copy it must not make." >&2
  exit 2
fi

mkdir -p "$(dirname "$DEST")"
rm -f "$DEST" "$DEST-wal" "$DEST-shm"

# Online .backup rather than cp: roots.db runs in WAL mode and a byte copy of a
# live WAL database is not guaranteed consistent.
sqlite3 "$SRC" ".backup '$DEST'"
echo "copied  $SRC -> $DEST  ($(stat -c%s "$DEST") bytes)"

sqlite3 "$DEST" <<'SQL'
PRAGMA foreign_keys=OFF;
BEGIN;

-- Both WeCom webhooks. The order group is not a lesser target than the alert
-- group: a harness that walks an order flow pages the people who pack the food.
DELETE FROM storefront_config WHERE key IN (
  'system_alerts.wecom_webhook',
  'notifications.wecom_order_webhook',
  'integrations.aliyun_sms.ak_secret',
  'integrations.feie.ukey',
  'integrations.jd.access_token',
  'integrations.jd.app_key',
  'integrations.jd.app_secret',
  'integrations.kd100.key',
  'integrations.kd100.secret',
  'integrations.kd100.callback',
  'customer_service.phone',
  'customer_service.url',
  'customer_service.qr_image_url'
);

-- Switch the features off as well as removing their keys, so a copy cannot be
-- "fixed" back into reaching production by someone pasting a webhook in.
UPDATE storefront_config SET value_json='false' WHERE key='system_alerts.enabled';

DELETE FROM tenant_secrets;
UPDATE tenant_integrations SET config_json='{}' WHERE config_json IS NOT NULL;

DELETE FROM eleme_tokens;
DELETE FROM retail_auth_tokens;
DELETE FROM platform_impersonation_tokens;
DELETE FROM retail_oauth_states;
DELETE FROM retail_otp_codes;
DELETE FROM retail_email_otp_codes;

DELETE FROM push_subscriptions;
DELETE FROM tenant_operator_push_subs;

COMMIT;
VACUUM;
SQL
echo "neutered outbound channels"

# ── verify, and refuse rather than hand back something that only looks safe ──
LEFT=$(sqlite3 "$DEST" "
  SELECT COALESCE(SUM(n),0) FROM (
    SELECT COUNT(*) n FROM storefront_config WHERE key IN (
      'system_alerts.wecom_webhook','notifications.wecom_order_webhook',
      'integrations.aliyun_sms.ak_secret','integrations.feie.ukey',
      'integrations.jd.access_token','integrations.jd.app_key','integrations.jd.app_secret',
      'integrations.kd100.key','integrations.kd100.secret','integrations.kd100.callback')
    UNION ALL SELECT COUNT(*) FROM tenant_secrets
    UNION ALL SELECT COUNT(*) FROM eleme_tokens
    UNION ALL SELECT COUNT(*) FROM retail_auth_tokens
    UNION ALL SELECT COUNT(*) FROM platform_impersonation_tokens
    UNION ALL SELECT COUNT(*) FROM push_subscriptions
    UNION ALL SELECT COUNT(*) FROM tenant_operator_push_subs
    UNION ALL SELECT COUNT(*) FROM tenant_integrations WHERE config_json NOT IN ('{}','')
  );")

ENABLED=$(sqlite3 "$DEST" "SELECT COALESCE((SELECT value_json FROM storefront_config WHERE key='system_alerts.enabled'),'absent');")

if [ "$LEFT" != "0" ]; then
  rm -f "$DEST" "$DEST-wal" "$DEST-shm"
  echo "REFUSED: $LEFT outbound channel row(s) survived the neutering. Copy DELETED." >&2
  echo "  A half-neutered copy is worse than none: it looks safe." >&2
  exit 1
fi

echo "verified: 0 outbound channel rows remain; system_alerts.enabled = $ENABLED"
echo "SAFE: $DEST"
