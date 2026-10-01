## §NEW — THE LAST OPEN WRITES ARE GATED; WHAT STAYS OPEN, AND WHY

**Built 2026-10-01 under §325** (Ash: *"let's start do them all"*).
This step closes the open writes that the S2e sweep found. Each now takes the
permissions that open every desktop and phone screen making that write today, as an
any-of (§325.3). What this closes is the account that can open none of those
screens. As with every gate in `lib/cap-routes.js`, nothing changes for the owner,
for a shop with enforcement off, or while an operator's permissions cannot be
resolved. No screen changed.

1. **Shop and channel open/close, per channel, per shop and per cell**
   (`POST /channel-status/cell|channel|location`).
   - These need one of the desktop Sales page's permissions: `dashboard:view`,
     `meituan:view`, `guanyi:view`, `eleme:view` or `integrations:view`
     (`TAB_CAP.sales`). The switches on that page carry no gate of their own.
   - The phone's per-shop and per-cell switches (§181, §253) are on its Sales
     screen, which opens on `dashboard:view`. That key is in the list, so the
     phone keeps them.
2. **Open or close everything, the online store, or one shop**
   (`POST /store-status/online|master|store/:code`).
   - They take the Sales permissions above plus the Settings tab's
     (`settings:shop|push|payments`, `stores:view`, `shipping:config`,
     `delivery:view`).
   - The only buttons are in the desktop's Settings → Operations, and they are
     drawn for `settings:edit`, which is not a real permission, so nobody presses
     them today.
   - §326.2 brings these switches to the phone. Using the same permissions as the
     per-channel switches means a phone screen built on either door is not refused
     from the start.
3. **Manual Alipay** (`PUT /alipay-manual`: the payment QR code, the AI key and
   auto-mark-paid) and **the printer** (`PUT /printer`) take the Settings tab's
   permissions.
   - Alipay is written from Settings → Push and from the setup guide, whose
     permission pair (`settings:shop` or `stores:view`) is part of the Settings set.
   - The printer is written from the desktop's Operations card and from the phone's
     auto-print switch on Operations, which is reached from Settings.
4. **Integration credentials** (`PUT /integrations`) are checked per service, in
   the handler (`integrationServiceCap`), the way S2a checks settings per key.
   - **kd100 and jd** (the couriers' keys) are the Delivery panel's: `delivery:view`
     or `delivery:edit`, or `shipping:config`.
   - **feie and spyun** (the Operations printer card) take the Settings permissions.
   - **wecom_app and aliyun_sms** (Settings → Push) take the Settings permissions.
   - **nuonuo** is written by no screen today, so it closes to `invoices:manage`.
   - If any one service in a save is refused, the whole save is refused and nothing
     is written. The refusal names the service.
5. **The fapiao settings** (`PUT /fapiao-settings`) are written by no screen, so they
   close to `invoices:manage`, the permission for issuing fapiao.
6. **Qingyun: request setup and auto-push** (`POST /integrations/qingyun/request|autopush`)
   need `delivery:view` or `delivery:edit`. Their only buttons are on the Delivery
   panel's Qingyun view.
7. **The setup guide's flags** (`POST /setup`) are checked per flag, in the handler
   (`setupFlagCap`).
   - `welcomeSeen` stays open: it is set when the first-login welcome is
     dismissed, and every operator sees that welcome.
   - `pickupConfirmed`, `storeOpened` and `storeInfoDone` are steps of the guide.
     They take the phone's Setup pair, `settings:shop` or `stores:view`.
   - This carries the same narrow edge as the currency key in S2a. The desktop's
     setup rail row has no gate of its own, so a narrowed operator who holds
     neither permission, on a shop that has not finished setup and has turned
     enforcement on, now loses those three steps.
8. **Product page templates** (`POST /page-templates`, `DELETE /page-templates/:id`)
   are written only by the product editor. They take the permissions of every way
   into that editor: `products:view` or `products:edit` (from Products),
   `editor:view` or `editor:edit` (the desktop Editor tab), and `content:edit` (the
   mini-app editor).
9. **Decided open, left ungated on purpose** (the coordinator's ruling):
   - **Connection tests**: `system-alerts/test`, `wecom/test`,
     `integrations/jd|nuonuo|aliyun_sms|kd100/test`, `printer/test`. Each sends one
     probe using credentials already saved, or ones typed into the form, and stores
     nothing.
   - **`poi-search`**: a place lookup for an address being typed. It reads from the
     maps provider and writes nothing.
   - **`geocode`**: turns one typed address into coordinates for the form in front
     of the operator, and writes nothing.
   - **`views` (`POST`, `PATCH /:id`, `DELETE /:id`)**: each operator's own saved
     filters, scoped to that operator. They grant nothing and move nothing.

   Still unmapped on the path, but gated elsewhere: `PUT /config` (per key, S2a),
   `POST /setup` (per flag, item 7), the channel sign-in (`integrations:signin`,
   checked in its own handler), and the `/shops` writes (`stores:edit`, checked in
   their handler). A re-run of the sweep finds those plus the two channel-sync false
   positives, and nothing else.
10. **Open for Ash, not decided here.** Following the screens means some gates are
    weaker than the write deserves:
    - Anyone who can open Sales (`dashboard:view`) may close a channel or a shop.
    - Anyone who can open Settings may change where the Alipay takings land, or
      switch on auto-mark-paid.
    - `delivery:view` may switch on Qingyun auto-push, which books couriers and
      spends the courier account's balance (`orders:dispatch_courier` is the
      permission that otherwise means that).

    Narrowing any of these takes a working switch from somebody, so it is Ash's
    call.
11. **Tests.** `scripts/test_last_open_writes.js` (fast shard, 65 checks) runs the
    real routers over a scratch database with enforcement on. It checks:
    - each write refused to an account outside its screens, and let through for
      each screen's permission;
    - integrations per service, including the whole save refused with nothing
      written;
    - setup per flag, including a refused save writing nothing;
    - the owner, and enforcement off;
    - the screen permissions and the caller list each gate is built from.
12. **Nothing composed.** No operator strings were added.
