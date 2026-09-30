## §NEW — THE AI READ AND ASK ON REPORTS ARE GATED ON THE SERVER, WITHOUT TAKING THEM FROM ANYONE

**Built 2026-09-30 under §300** (Ash: *"yes , and keep going until you finish all .I approve all"*).
Found while building F5. `POST /api/retail-admin/reports/read` and `/reports/ask` are billed
model calls that read the period's figures back, revenue included. Neither matched a rule in
`lib/cap-routes.js`, so both fell through open: any signed-in operator could make them,
whether or not enforcement was on. Both are now gated.

1. **The same people as before.** The gate accepts either of the two permissions that open a
   screen calling these routes today: `reports:view`, which opens the desktop's Reports tab
   (`01-core.js` `TAB_CAP`), and `dashboard:view`, which opens the phone's Trend (`m.html`
   `ROUTE_CAP`). Anyone who can reach either screen keeps the read and Ask. The accounts
   refused are those who could reach neither screen and so had no page that called these
   routes. This follows the rule for this lane's server changes: no working access is removed
   while Ash is asleep.
2. **The paths must match exactly**, so nothing else under `/reports` inherits the gate. The
   reads behind both screens (`GET /dashboard`) stay open, as every read does.
3. **The phone is narrower than the server, on purpose and on the record.** F5 shows the read
   and Ask only for `reports:view`, and never on the no-money boards. The server stays at the
   wider of the two keys until Ash decides whether a Trend-only (`dashboard:view`) account
   should have the AI read at all. That question is left open.
4. **Unchanged:** the owner, a shop with enforcement off, and an operator whose permissions
   cannot be resolved, all as before.
5. **Tests.** `scripts/test_reports_ai_gate.js` (fast shard) checks:
   - the rule;
   - who gets through (either key, the owner, enforcement off, unresolved permissions) and who
     is refused (orders-only, warehouse, nothing held), through a copy of the permission check
     that is itself checked against `routes/retail.js`;
   - that the two screens still open on the keys the rule names;
   - that the phone Trend and desktop Reports are the only callers.
