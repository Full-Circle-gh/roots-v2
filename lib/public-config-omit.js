'use strict';

/* §436 — STAFF-ONLY CONFIG KEYS THE SERVER STILL NEEDS TO READ.
 *
 * A WeCom group-bot URL carries its secret in `key=`: whoever holds it can post
 * anything into that staff group, a fake "new order" card included. These keys
 * cannot go in routes/retail.js's PRIVATE_CONFIG_PREFIXES, because loadConfig()
 * is also what the bots resolve their URL from (wecomWebhookUrl(), the System
 * Alerts test) and what the admin GET /api/retail-admin/config answers with —
 * both settings screens load the saved URL from there. A private prefix would
 * blind all of them. So they are removed from the PUBLIC response only, in
 * GET /api/retail/config, and from anything captured off it
 * (scripts/build_gallery_fixtures.js).
 *
 * scripts/test_public_config_secrets.js fails when a storefront_config key with
 * "webhook" in its name appears in the code without being listed here or sitting
 * under a private prefix, so a new bot is caught the day it is written.
 */
const PUBLIC_CONFIG_OMIT = [
  'notifications.wecom_order_webhook',   // new-order alert group
  'system_alerts.wecom_webhook',         // system alert group
  'gzgrocery_orders.wecom_webhook',      // gzgrocery order feed (lib/gzgrocery-order-notify.js)
];

// Deletes each listed key from a NESTED config object (the shape loadConfig()
// builds) in place, and returns it.
function omitPublicConfigKeys(cfg) {
  for (const dotted of PUBLIC_CONFIG_OMIT) {
    const segs = dotted.split('.');
    const last = segs.pop();
    let cur = cfg;
    for (const seg of segs) cur = cur && typeof cur === 'object' ? cur[seg] : undefined;
    if (cur && typeof cur === 'object') delete cur[last];
  }
  return cfg;
}

module.exports = { PUBLIC_CONFIG_OMIT, omitPublicConfigKeys };
