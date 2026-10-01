## §NEW — GZGROCERY BILLING AND THE STATEMENT ON THE PHONE

**Built 2026-10-01 under §325.** This is step X8e, the last part of X8, on
the Settings / Channels / Dashboard / Billing lane. The desktop GZ Grocery
tab's Billing panel is on the phone (`12-guanyi.js` `gyLoadAnalytics`,
`gyRenderAnalytics`, `gyExportStatement`). It is reached from **Billing**
on the gzgrocery screen's card. It is read-only.

1. **The read is the desktop's:** `GET /guanyi/analytics?period=&from=&to=`.
   - **It opens with no period and no dates,** so the server's default
     applies (the last 90 days), as on the desktop.
   - **Day / Week / Month** re-scope the range the way `gyPeriodRange` does:
     Monday-start weeks, the month so far, on the shop's calendar day. The
     suite runs the desktop's function against the phone's.
   - **The two date fields** set the range by hand.
2. **What it shows, as the desktop does:**
   - units ordered, what they owe (at the gzgrocery price), the retail value,
     the average discount, and the number of products;
   - the warning for ordered products with no gzgrocery price;
   - the breakdown by period;
   - the products, top 50, with "full list in the CSV" beyond that.
3. **Statement CSV** is the desktop's file byte for byte: BOM, columns,
   quoting, two decimals, the TOTAL line and the file name. The suite runs
   the desktop's own `gyExportStatement` on the same answer and compares.
4. **Who can open it.** This is what another business owes the shop.
   - The desktop shows it to anyone on the GZ Grocery tab (`guanyi:view`),
     and so does the phone.
   - Not on the boards that never see money (`recapNoMoney`: warehouse,
     dispatch, customer service), the rule Finance and Home's recap follow.
   - The check sits in `canRoute`, next to Finance's.
