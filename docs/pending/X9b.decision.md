## §NEW — THE WECHAT MINI PROGRAM'S SETUP AND CONFIGURATION ON THE PHONE

**Built 2026-10-01 under §325.** This is step X9b on the Settings / Channels /
Dashboard / Billing lane, the second of X9's three parts (X9a the hub, X9c the
web store). The desktop's Mini App pages (`15-integrations.js`:
`igMiniappConfig`, the `igMiniappSetup` wizard, `igMwVerifyLogin`,
`igMwSaveMch`, `igMwVerifyPay`, `igMwFinish`, `igMiniappConfigFull`,
`igSaveMiniappCreds`) are on the phone. They open from the WeChat mini
program's card in the channel hub, which no longer says "Set up on desktop for
now".

1. **The read is the desktop's:** `GET /channel-hub/miniapp/wechat-config`.
2. **Which page opens is the desktop's rule:**
   - the account the server's own config fills (`source: 'env'`), or one
     whose login works and whose payments are ready or put off, gets the
     one-page configuration;
   - anyone else gets the wizard, at the first step not done.
   - **One phone rule on top:** somebody without `integrations:manage` gets
     the configuration page read-only, because the wizard is nothing but
     saves.
3. **The wizard's writes are the desktop's, with the same bodies:**
   - Step 1: `POST /channel-hub/miniapp/wechat-creds {appId, appSecret}`.
     WeChat must accept the pair to go on.
   - Step 2: the same endpoint, `{mchId}`.
   - Step 3: `POST /channel-hub/miniapp/wechat-pay-verify {serialNo,
     apiV3Key, privateKey, platformPubKey}`, a real signed call to WeChat Pay.
     When it fails, "Finish anyway" appears, as on the desktop.
   - Each step makes the desktop's checks before anything is sent: the AppID's
     shape, the secret present, the merchant ID a number, the v3 key 32
     characters, the key file a private key.
   - "Do it later" on step 1 closes. On steps 2 and 3 it puts payments off
     and finishes. "Put off" is remembered on this device under the desktop's
     own key (`fc_miniapp_pay_skip`).
4. **The configuration page's Save & verify** sends the desktop's seven
   fields to `wechat-creds`. The server's own config account sees its values
   read-only, as on the desktop.
5. **Secrets.**
   - The server never sends a saved secret, only whether it is set. The phone
     keeps only those flags of what it reads, so even a server that sent one
     could not have it drawn.
   - A saved secret shows as dots and "Saved". Replace opens an empty box;
     "Keep saved value" closes it and throws away what was typed.
   - A secret goes in the body only as typed. A box left empty sends `''`,
     which the server reads as "keep the stored one", exactly the desktop's
     body.
   - What was typed is dropped once the server has stored it, and whenever
     the wizard moves to another step.
6. **Who can save.** Every write is `integrations:manage`, the server's key for
   `/channel-hub` (`lib/cap-routes.js`). Without it nothing is drawn to press
   and the commands send nothing.
7. **The three states.** Each button disables and says what it is doing
   ("Checking with WeChat…", "Verifying…"). A refusal or WeChat's no is said
   in place and stays. A toast only confirms a verified save.
