## §NEW — THE WEB STORE'S CONFIGURATION ON THE PHONE

**Built 2026-10-01 under §325.** This is step X9c on the Settings / Channels /
Dashboard / Billing lane, the last of X9's three parts (X9a the hub, X9b the
WeChat mini program). The desktop's Web store configuration
(`15-integrations.js`: `igWebConfig`, `igWebSaveSignin`, the `wcSite*` editor,
`wcSiteProblems`, `igWebAddDomain`, `igWebCheckDns`, `igWebRemoveDomain`) is on
the phone. It opens from the web store's card in the channel hub. With it, no
card in the hub sends anyone to the desktop.

1. **The read is the desktop's:** `GET /channel-hub/web/config`. It shows:
   - the three ready marks;
   - the shop address: the live one (Copy, Open), the free one reserved, or
     none yet;
   - the domains you added;
   - the five sign-in ways;
   - the title, menu and footer;
   - payments.
2. **Domains, with the desktop's endpoints and bodies:**
   - Add: `POST /channel-hub/web/domain {host}`, trimmed and lower-cased,
     with the desktop's word for each refusal (`bad_domain`, `reserved`,
     `taken`, `already_yours`).
   - A pending one shows the CNAME record to add. Check DNS:
     `POST /channel-hub/web/domain/:id/check`.
   - Remove: asked first, then `DELETE /channel-hub/web/domain/:id`. The
     platform address is never offered for removal, as the server refuses it.
3. **Save changes sends the desktop's two writes, one after the other, each
   reported on its own:**
   - `POST /channel-hub/web/signin {phone, email, google, apple, wechat}`. A
     way that is not available cannot be switched on.
   - `POST /channel-hub/web/site` with the eight fields, in the desktop's
     order.
   - Before either is sent, the desktop's own check runs: a bare domain gets
     its `https://`, and a menu or footer row the server would drop is named.
     The suite runs the desktop's `wcSiteProblems` side by side with the
     phone's.
   - A failure names the part ("Save failed: sign-in"), and the other part is
     still sent, as on the desktop.
4. **Payments:** WeChat Pay with Open WeChat config, which opens the X9b page;
   Alipay's state. Alipay's QR is set up in X10, which will add its door here.
5. **One difference, on purpose.** After a domain is added or removed, the
   desktop reloads its whole page and throws away sign-in switches and site
   words not yet saved. The phone reads the page again but keeps them.
6. **Who can save.** Every write is `integrations:manage`, the server's key for
   `/channel-hub` (`lib/cap-routes.js`). Without it the page is read-only and
   nothing is sent.
7. **The three states.** Each button disables and says what it is doing
   ("Saving…", "Adding…", "Checking DNS…"). A refusal or failure is said in
   place and stays. A toast only confirms a save or a copy.
