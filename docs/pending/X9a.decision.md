## §NEW — THE CHANNEL HUB AND ITS SETUP WIZARDS ON THE PHONE (PART ONE)

**Built 2026-10-01 under §325.** This is step X9a on the Settings / Channels /
Dashboard / Billing lane. X9 was split in three because the three groups of
wizards share nothing but the hub:

- **X9a (this):** the hub itself, the to-dos, Get help, the Meituan / Qingyun
  box, Eleme's two steps, and JD's door.
- **X9b (to do):** the WeChat mini program wizard (the AppID and secret, WeChat
  Pay, the pay check).
- **X9c (to do):** the web store wizard (sign-in, the site, domains, DNS).

The desktop's channel hub (`15-integrations.js`: `igLoad`, `igCard`, `STATUS`,
`igDismissTodo`, `igHelp`, `igRelayWizard` / `igRelayBoxRequest`,
`igElemeWizard` / `igElemeShop` / `igElemeEnable`, `igLaunchSetup`) is on the
phone. It is reached from **Configure** on the Sales screen.

1. **The read is the desktop's:** `GET /channel-hub`, the cards and the stores.
   Every card shows its state in the desktop's seven words, its health line
   or its blurb, and its open to-dos ("New location … — link it here").
2. **The writes are the desktop's, with the same bodies:**
   - Dismiss a to-do: `POST /channel-hub/:kind/todos/dismiss {todoId}`.
   - Get help: `POST /channel-hub/help {kind, note}`. The note is optional,
     as the desktop's prompt makes it.
   - Request the box: `POST /channel-hub/:kind/box-request {}`.
   - Link an Eleme shop: `POST /eleme/shop {storeId, storeCode, shopId}`.
     Nothing is sent with the box empty, as on the desktop.
   - Enable Eleme: `POST /eleme/enable {enabled:true}`.
   After each, the hub is read again, as the desktop's `igLoad()` does.
3. **Where Set up / Manage / Fix go follows `igLaunchSetup`:** Meituan and
   Qingyun to the box screen; Eleme to its two steps; JD to the phone's JD
   Logistics keys (X7). The WeChat mini program and the web store say "Set up
   on desktop for now" until X9b and X9c.
4. **The box screen follows the box's state** from the card's config:
   none yet (what it is, Request the box, "I already have it — continue"),
   requested, shipped (with its date and tracking), delivered. Continuing
   opens Get help, which is how a box gets connected (§257).
5. **Who sees what.** Each control is the server's key (`lib/cap-routes.js`):
   - `integrations:manage` for Get help, the box and Dismiss;
   - `eleme:sync` for the shop ids and Enable.
   Without the key the control is not drawn and the command sends nothing.
   The hub opens for the Sales page's keys.
6. **The three states.** Each button disables and says what it is doing; a
   refusal or failure is said in place and stays; a toast only confirms.
