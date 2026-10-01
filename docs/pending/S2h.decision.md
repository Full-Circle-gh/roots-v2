## §NEW — THE TEST BUTTONS THAT SEND SOMETHING REAL NEED A PERMISSION

**Built 2026-10-01 under §325** (Ash: *"let's start do them all"*).
Seven test endpoints matched no rule (six with buttons, and nuonuo's) in `lib/cap-routes.js`, so anyone signed in
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
   - **Desktop:** all six buttons are in `02-settings-ops.js` and
     `05-marketing.js`, on the panels above.
   - **Phone (X7, #966).** It presses all six:
     - the test print (`x7PrnTest`) runs only behind `canRoute('printers')`;
     - the WeCom, SMS and system-alert tests run only behind
       `canRoute('pushcfg')`;
     - the kd100 and JD tests (`x7SvcTest`) run only behind
       `canRoute('kd100cfg' / 'jdcfg')`.
   - Each of those phone routes opens on exactly the permissions this step gates
     on: the Settings tab's six for `printers` and `pushcfg`, and
     `delivery:view|edit` or `shipping:config` for the two courier routes.
   - So no phone operator who can press a test loses it. The suite reads both the
     phone's routes and the server's rules, and fails if they ever drift apart.
5. **Who is refused now:** only an account that can open neither panel. An
   orders-only account can no longer print, text or message through these
   buttons. An account holding only Settings → Push permissions can no longer
   ping the couriers, whose buttons are on the Delivery panel.
6. **The nuonuo test** (`POST /integrations/nuonuo/test`) needs `invoices:manage`,
   the same as its credentials (S2f). No screen presses it, so nobody loses it.
7. **Tests.** `scripts/test_send_test_gates.js` (fast shard, 60 checks) runs the
   real router over a scratch database with enforcement on. It checks:
   - each rule;
   - each endpoint refused to an account outside its panel, and let through for
     the panel's permission and for the owner;
   - enforcement off;
   - that each button sits on the panel its rule names, and who calls the
     endpoints;
   - that each phone test command runs behind a route whose permissions the
     server admits.
8. **Nothing composed.** No operator strings were added.
