## §NEW — THE TEST BUTTONS THAT SEND SOMETHING REAL NEED A PERMISSION

**Built 2026-10-01 under §325** (Ash: *"let's start do them all"*).
Six test endpoints matched no rule in `lib/cap-routes.js`, so anyone signed in
could make them. S2f recorded them as left open because "they store nothing".
That reason does not hold: each one sends something real, whether a printed
ticket, an SMS, a WeCom message or a call to a courier's API. Each is now gated
by §325.3: the permissions that open the panel its button sits on, which are the
same permissions as the Save next to it. As with every rule in that file, nothing
changes for the owner, for a shop with enforcement off, or while an operator's
permissions cannot be resolved.

1. **Print a test ticket** (`POST /printer/test`) needs one of the Settings tab's
   permissions: `settings:shop`, `settings:push`, `settings:payments`,
   `stores:view`, `shipping:config` or `delivery:view`. Its button is drawn into
   the printer card in Settings → Operations, which has no gate of its own. These
   are the same permissions as `PUT /printer` (S2f).
2. **Send a test SMS** (`/integrations/aliyun_sms/test`), **test the WeCom
   webhook** (`/wecom/test`) and **send a test system alert**
   (`/system-alerts/test`) need the Settings tab's permissions. All three buttons
   are in Settings → Push, which has no gate of its own.
3. **Test the kd100 and JD couriers** (`/integrations/kd100/test`,
   `/integrations/jd/test`) need `delivery:view`, `delivery:edit` or
   `shipping:config`. That is what `integrationServiceCap` gives their
   credentials (S2f). Their buttons are in the Delivery panel's tracking and JD
   views, which open on `delivery:view`.
4. **Callers.**
   - On the desktop, all six buttons are in `02-settings-ops.js` and
     `05-marketing.js`, on the panels above.
   - The phone presses none of them in the code merged so far (main at
     `4c5844f4`); the X7 phone work had not landed.
   - When it lands, a phone test print on Operations will sit behind Settings.
     Every permission the phone's Settings opens on is admitted here, and the
     suite checks that once the phone calls it.
5. **Who is refused now:** only an account that can open neither panel. An
   orders-only account can no longer print, text or message through these
   buttons. An account holding only Settings → Push permissions can no longer
   ping the couriers, whose buttons are on the Delivery panel.
6. **Still open, not asked for here:** `POST /integrations/nuonuo/test`. No screen
   presses it. It is listed so the decision can be taken with the others; the
   natural gate would be `invoices:manage`, as for the nuonuo credentials.
7. **Tests.** `scripts/test_send_test_gates.js` (fast shard, 41 checks) runs the
   real router over a scratch database with enforcement on. It checks:
   - each rule;
   - each endpoint refused to an account outside its panel, and let through for
     the panel's permission and for the owner;
   - enforcement off;
   - that each button sits on the panel its rule names, and who calls the
     endpoints.
8. **Nothing composed.** No operator strings were added.
