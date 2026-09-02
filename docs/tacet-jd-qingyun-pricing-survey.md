# JD and Qingyun — where the courier's PRICE is, and when it becomes knowable

**2026-09-02 · Read-only survey. No code was changed, no schema was altered, no request was
sent to JD or Qingyun, and no database was opened.** Commissioned as a follow-up to
`docs/tacet-courier-cost-survey.md` (branch `claude/courier-cost-survey-e5s4a6`), which
established that Qingyun's `totalFee` is quoted, displayed, spent and never written, and that
`lib/jd.js` carries no price field at all. This survey asks the next question: **JD must price
the shipment or we could not be billed — so where is that price, and when does it exist?**

Repository at `origin/main` `d510b048`, synced at survey time.

---

## 0 — Scope note, stated first because it bounds four of the five answers

This session runs in an ephemeral container with **no `data/roots.db`**. `database.js:26` opens
`path.join(DATA_DIR, 'roots.db')`; neither that file nor the `data/` directory exists here, and
no remote database is configured in the environment. There are also **no log files on disk**
anywhere in the tree.

Therefore:

- **No live row was read.** Question 4's "does a live row carry a fee" and question 5's "what
  does a single live row contain" **were not measured by this survey** and are answered as
  structure-from-code plus an explicit statement of what remains unmeasured.
- **No captured JD response was inspected, because none exists.** This is itself a finding, not
  a limitation of the container — see §4. The repository contains no JD fixture, no JD test, no
  vendored JD API document, and no table or column that has ever held a JD reply.

Where this document says "the column does not exist" or "no code path retains this", that is a
fact about the tree and is established from code.

---

## 1 — The one-paragraph answer

**JD never tells us a price, on any call we make, at any point in the parcel's life.** Six
endpoints are called across two gateways; five return status/identifier objects with no money
in the fields our code reaches for, and the sixth returns an **encrypted** blob we forward
verbatim to a printer without ever decrypting it — so if a freight figure exists anywhere in
what JD hands us, it is inside that blob and is unreadable server-side. Worse for any
creation-time costing: **every JD waybill Tacet creates declares a hardcoded 1 kg and 100 cm³**
(`routes/retail.js:27339-27340`; the admin UI never sends the real ones,
`public/retail-admin/04-orders.js:7054`), so JD cannot be pricing from what we declare and no
figure returned at creation could have been the real one. The charge is knowable to us only out
of band, from the JD merchant account's own billing — meaning **after the fact, not at waybill
time**. Qingyun is the opposite case and a more subtle one: the fee is known *before* we spend
it, but the number the operator sees and the number the wallet is debited are produced by
**two different quote calls**, and on a concurrent dispatch the UI shows no fee at all — so
"quoted" and "settled" can already differ today, by construction, and neither is stored.

---

# PART A — JD

## A1 — Every JD endpoint `lib/jd.js` calls, and what its response carries

`lib/jd.js` is the only file that calls JD. `callJd` and `callJdl` are exported but **no other
file invokes them** (verified: no `jd.callJd` / `jd.callJdl` anywhere outside the module), so
this table is the complete JD surface of the system.

Two gateways are in play: **JOS** (`https://api.jd.com/routerjson`, `apiBase()` — note sandbox
and production are the same host, `lib/jd.js:104-108`) and **JDL** (`https://api.jdl.com`,
`callJdl`), which is a separate open-platform app with its own key, secret and token.

| # | Endpoint | Called from | Gateway | Fields our code reads from the response | Money in the response? |
|---|---|---|---|---|---|
| 1 | `jingdong.etms.range.check` | `pingJd` `:174` | JOS | none — the call exists only to prove the credentials clear JD's auth gateway; a *business* error is treated as a PASS (`:180-187`) | **No.** Nothing is read, and a coverage check has no price to give. |
| 2 | `jingdong.etms.waybillcode.get` | `allocateWaybillCode` `:203` | JOS | returns `callJd`'s raw `inner` to the caller; **nothing calls it** — `createWaybill` uses endpoint 3's single-call flow instead (`:245-248`) | **No**, and moot: dead code on the live path. |
| 3 | `jingdong.ldop.waybill.receive` | `createWaybill` `:257` | JOS | `receiveorderinfo_result` → `resultCode`, `resultMessage`, `deliveryId`, `preSortResult` (`:259-263`) | **No.** `deliveryId` is the waybill number; `preSortResult` is the pre-sort site (destination depot/road code). Neither is a charge. |
| 4 | `/PullDataService/pullData` | `getPrintData` `:375` | JDL | outer `code`, then `prePrintDatas[]` → per-entry `code`, `msg`, `perPrintData`, `wayBillNo` (`:383-390`) | **Unreadable.** `perPrintData` is JD's **encrypted** label payload (`lib/jd.js:268-271`, `:357`), forwarded byte-for-byte to the local 京东打印组件 over `ws://127.0.0.1:9113` (returned verbatim at `routes/retail.js:28239-28241`, handed to the component at `public/retail-admin/04-orders.js:6909-6912`). A printed JD waybill can carry a 运费 area — **so this is the one JD payload that plausibly contains a price, and it is the one we structurally cannot read.** |
| 5 | `jingdong.ldop.receive.trace.get` | `getTrace` `:398` | JOS | `querytrace_result.data[]` → `opeTime`, `opeRemark`, `opeTitle`, `opeCityName`, `opeProvinceName` (`normalizeTrace`, `:410-417`) | **No.** Five scan fields, all descriptive. |
| 6 | `jingdong.ldop.delivery.provider.cancelWayBill` | `cancelWaybill` `:432` | JOS | `responseDTO.statusCode`, `statusMessage` (`:440-441`) | **No** — and notably no cancellation-fee figure either. |
| 7 | `jingdong.ldop.receive.order.intercept` | `interceptWaybill` `:449` | JOS | `resultInfo.stateCode`, `stateMessage` (`:455-456`) | **No.** |

**On "the actual response shape we receive, not just the fields we read" — that shape cannot be
inspected, and here is exactly why.** The full JD envelope is destroyed at three successive
points before anything could see it:

1. `callJd:154` picks `j[base + '_response']` (or the misspelled `_responce`) out of the parsed
   body and returns **only that inner object**; the local `j` — the complete envelope — goes out
   of scope and is never returned, logged, or stored.
2. `createWaybill:259` narrows again to `r.data.receiveorderinfo_result`, discarding whatever
   else the `_response` wrapper carried.
3. The one place a JD reply is emitted at all is a diagnostic `console.log` at
   `routes/retail.js:27377` — `JSON.stringify(cr.raw || cr)` — and `cr.raw` is that
   innermost object from step 2, **not** the envelope. It goes to stdout only; there are no log
   files in this tree and nothing writes it to the database.

So the honest statement is: **the system has never retained a JD response, so no one — this
survey included — can say from our own data what JD actually sends back.** That question is
answerable only by a live call with the envelope printed before `callJd` narrows it.

## A2 — A separate JD pricing / quote / billing endpoint we do not call

**The integration reveals none, and the repository contains no JD API documentation to reveal
one.**

What was checked:

- `lib/jd.js:9-15` states the module's own "full daily workflow" as five methods — range check,
  waybill-code allocation, waybill submit, trace, intercept. **No pricing step appears in the
  author's own map of the API.**
- No JD API document is vendored anywhere. `reference/` holds mockups and
  `china_regions.json`; `docs/` holds no JD file. The only two JD URLs in the tree are a label
  **template** host (`template-content.jd.com`, `lib/jd.js:288-293`) and one comment link to
  `cloud.jdl.com`'s carrier list (`:287`) — neither is an API reference.
- The `grep` the brief implies was run repo-wide: **no `fee`, `cost`, `price`, `freight`,
  `amount`, `settlement`, `运费` or `结算` identifier appears in any JD context anywhere in the
  system**, not in `lib/jd.js`, not in the routes, not in the admin UI, not in the plan docs.
  `CHANNELS-LOGISTICS-PLUGINS-PLAN.md` mentions JD five times and never mentions billing.

**One piece of hard evidence about what is even callable.** `pingJd`'s comment
(`lib/jd.js:163-168`) records that `jingdong.time.get` is **not subscribed** for this app and
returns gateway code 15, which is why the ping probes `etms.range.check` instead. The account's
JOS app is therefore subscribed to a *narrow* method list, and **that list is not in the
repository**. Whether a pricing method exists for this merchant is decided by that subscription
list plus the JDL platform's own interface catalogue — neither of which this survey can read.
I am not going to name a method from memory; an unverified endpoint name in a findings document
is worse than none.

**A2 answer: nothing in the integration or in any document it carries reveals a JD pricing,
quote, or billing endpoint. The question is open and is not answerable from the repository.**

## A3 — At what point JD's charge becomes known

**On the evidence in this tree: at no point in anything we call.** Taking the parcel's life in
order —

| Moment | What we call | Is a charge available? |
|---|---|---|
| Label creation | `ldop.waybill.receive` | **No figure in what we read** (`resultCode` / `deliveryId` / `preSortResult`). And see the weight finding below — a creation-time figure could not have been the real one anyway. |
| Label printing | `pullData` | Possibly present, **encrypted, never decrypted** (§A1 row 4). |
| Pickup / in transit / delivery | `receive.trace.get` | **No.** Five descriptive scan fields. |
| Cancel before pickup | `cancelWayBill` | **No** — not even a cancellation fee. |
| Intercept after pickup | `receive.order.intercept` | **No.** |
| Monthly | *(nothing)* | **We call nothing here.** No JD billing or settlement call exists in the system. |

**The weight finding, which settles the "at label creation" option on its own.** The create
route defaults `weight` to **1 kg** and `vloumn` to **100 cm³** when the request body omits
them (`routes/retail.js:27339-27340`), and the admin UI that creates every real waybill sends
only `{ shipment_id, product, package_count }` — **never a weight or a volume**
(`public/retail-admin/04-orders.js:7054`). So every JD waybill Tacet has ever created was
declared to JD as a 1 kg, 100 cm³ parcel. JD cannot be pricing from that; whatever it bills is
derived from its own weighing and measurement, which happens **after the parcel leaves us**.

**Therefore, code-supported conclusion:** the charge is not knowable at waybill time, and a cost
written at waybill time could only ever be an estimate we computed ourselves, not a figure JD
gave us. **Inference beyond the code, marked as such:** the earliest a *true* JD charge can
exist is after JD weighs the parcel at intake, and the earliest we can *see* it is when it
appears on the merchant account's own bill — i.e. the "only on a monthly bill" option, unless
the JOS subscription list (§A2) turns out to contain a per-waybill fee query we have never
called. That inference is not established by this repository and should not be treated as
established.

## A4 — Do we retain raw JD responses, the way `eleme_order_import` retains Eleme payloads?

**No. There is no JD equivalent, at any level.**

The Eleme comparison, stated precisely so the gap is exact:

| | Eleme | JD |
|---|---|---|
| Retention table | `eleme_order_import` (`database.js:5416-5425`) | **none — no `jd_*` table exists anywhere in `database.js`** |
| Raw column | `raw_payload TEXT` (`:5423`) | **none** |
| Event log | `eleme_sync_log` (`:5430-5439`) | **none** |
| Where the response lands instead | persisted, and read back — `scripts/repair_eleme_order_fees.js`, `scripts/fix_eleme_order_money.js` and `scripts/diagnose_channel_money_gaps.js:203` all re-read `foodInfo.deliveryFee` out of stored payloads *months later* | **stdout only** (`routes/retail.js:27377`), with the envelope already stripped (§A1) |

The three JD writes that do happen carry no JD response data:

- **Waybill create** writes `tracking_carrier='jd'`, `tracking_number`, `tracking_status`,
  `package_count`, `dispatched_at` to `retail_shipments`, mirrored to `retail_orders`
  (`routes/retail.js:27385-27404`). `retail_shipments`' full DDL is `database.js:3388-3408`
  plus five migrations (`:3418`, `:3425`, `:3430`, `:3439-3440`) — **no money column, and none
  has ever existed.**
- **Trace sync** writes only the *normalized* events —
  `JSON.stringify(norm.events)` into `tracking_events_json` (`routes/retail.js:11814-11831`),
  where each event has been reduced by `normalizeTrace` to four fields. **JD's own trace payload
  is discarded in the same expression that reads it.**
- **Activity log** records `{ waybill, product, shipment_id, package_count }`
  (`routes/retail.js:27417`) — an audit note, not a payload.

**A4 answer: we retain nothing. There is no table to name and no column to name, so "does a
live row carry a fee" has no row to ask it of.** The one adjacent place a JD waybill sits
beside money is the legacy import `scripts/miniapp_2025_import.json`, whose records pair a
`tracking_no: "JDVC…"` with a `delivery_fee` (e.g. `"delivery_fee": 17`) — but that is the fee the
**customer paid us** (`income = product_total + delivery_fee`), not JD's charge, and it is a
2025 file, not live data.

---

# PART B — Qingyun

## B1 — Can the QUOTED fee and the SETTLED fee differ?

**Yes — and not as an edge case. Five mechanisms are visible in the code, and one of them fires
on every single dispatch.**

First, the quote itself. `quoteCarriers` (`lib/qingyun-browser.js:567-609`) calls
`delivery/queryShopPreviewConfig` for the carrier list, then `delivery/previewSingle` **per
carrier**, reading `d.totalFee` (cents) → `feeCents` / `feeYuan` (`:591-592`) together with a
`waybillId` that **expires**. `dispatch` (`:617-641`) posts those figures straight back as
`deliveryFee` inside the `delivery/create` body (`:629`), and that call **debits the merchant's
prepaid Qingyun wallet** (`routes/retail.js:25031-25032`; the operator is told so in the
confirm dialog, `public/retail-admin/04-orders.js:4800-4805`).

Now the five divergences:

1. **Two different quotes — this one fires every time.** The operator sees prices from the
   `GET …/qingyun/carriers` call, rendered as `¥${c.feeYuan}` at
   `public/retail-admin/04-orders.js:4783`. The dispatch route then **re-quotes** —
   `const q = await br.quoteCarriers(ref.qyOrderId); // fresh waybills`
   (`routes/retail.js:25056`) — matches the operator's pick by `carrierId` + `serviceCode`, and
   spends **whatever the fresh quote says**. The price clicked and the price charged are
   produced by two separate calls to a live pricing engine, seconds to minutes apart. The
   response echoes the *fresh* figure (`:25071`), so the confirmation is truthful — but it is
   not necessarily the number the operator agreed to.
2. **Concurrent dispatch (并发发单) — several quoted, one billed.** `dispatch` accepts an array;
   Qingyun calls all of them and "whoever accepts first takes the order and only that one is
   billed" (`lib/qingyun-browser.js:610-614`). The route returns **every** chosen carrier's fee
   (`routes/retail.js:25071`), so the quoted set is a superset of the single real charge. And
   in the multi-carrier branch **the UI prints only the carrier names, no fee at all**
   (`public/retail-admin/04-orders.js:4816-4820`) — so on a concurrent dispatch the settled fee
   is never displayed, let alone stored.
3. **Tips.** `dispatch(qingyunOrderId, carrier, tipCents = 0)` supports a 小费 and rides it into
   the create body as `tipAmount` (`lib/qingyun-browser.js:617`, `:632`). The route never passes
   one, so it is 0 today — a live divergence path that is currently dormant, named because it is
   one parameter away from firing.
4. **Cancelling a live delivery can carry a fee, and we neither charge nor see it.**
   `cancelOrder`'s own scope note (`lib/qingyun-browser.js:545-548`) says that once a courier has
   been called the portal offers a different action — "cancelling a live delivery, which **can
   carry a fee**" — and that this path was never recon'd. So a wallet debit can occur for an
   order whose only quoted figure was the original delivery fee.
5. **Weight and insurance are hardcoded to zero.** `previewSingle` is quoted with
   `insuredMark=0` (`:581`) and `delivery/create` is posted with `adjustedWeight=0`,
   `insuredMark=0` (`:639`) and `discountFee: 0, insuredFee: 0` (`:630`). The portal's
   weight-adjustment path exists and we never use it — so an over-weight parcel re-priced by the
   carrier settles above the quote with nothing on our side recording the difference.

**And the settled truth lives somewhere we never read.** The fee is deducted from a **prepaid
wallet**, so the authoritative record of what each delivery actually cost is the Qingyun wallet
ledger. No code in this system reads a wallet balance or a wallet transaction; the only trace
the balance leaves is an error-string match — `/余额|余额不足|balance|充值/i` — used to tell the
operator a dispatch failed for insufficient funds (`routes/retail.js:25064`).

## B2 — Does `delivery_jobs.raw_order` already hold a settled figure?

**Unverified, and it cannot be verified from the repository — but three structural facts narrow
it sharply.**

What `raw_order` is: `scripts/qingyun-daemon.js:368` writes
`JSON.stringify(d.raw).slice(0, 20000)`, where `d.raw` is the untouched **`order/list`
`dataList[]` entry** as Qingyun returned it (`lib/qingyun-browser.js:264`). The column is
declared at `database.js:5089` and commented "last order/list object (debug / first-capture)".

1. **It is an `order/list` entry, not a delivery/billing object.** The fee lives on
   `delivery/previewSingle` (the quote) and is *posted to* `delivery/create`. `order/list` is
   the order tab listing. Whether Qingyun folds a settled delivery fee into that listing entry
   is exactly the unknown.
2. **`_parseOrder` names twenty fields and not one is money**
   (`lib/qingyun-browser.js:245-266`): identifiers, channel, two status enums, carrier, rider
   name/phone, recipient name/phone/address/lat/lng, remark, expected time. That tells us
   nothing about what *else* is in the object — the parser is a whitelist, and `raw` is kept
   precisely because it is wider than the whitelist.
3. **Nobody has ever read it.** Across the whole tree, `raw_order` appears **only** in the
   daemon's write (`:368`, `:379`, `:385`, `:405`). The sibling `raw_track` *is* read back
   (`routes/retail.js:12356`, for the rider's route coordinates); `raw_order` is **write-only**.
   `docs/tacet-consolidation-decisions.md:1054` corroborates this — it lists
   `delivery_jobs.raw_order` as "the JSON money the standing rule leaves in yuan", i.e. the
   consolidation work knew it might hold money and deliberately did not touch it.

**A truncation caveat that matters if it does hold a fee.** The write is
`.slice(0, 20000)` on the *stringified* object. A Qingyun `order/list` entry that exceeds 20 kB
is stored as **invalid JSON** — a truncated string. Any figure past that cut is gone, and so is
the parseability of everything before it. Whether live entries approach 20 kB is unmeasured.

## B3 — What a single live row contains

**Not measurable in this session.** There is no `data/roots.db`, no remote database, and no
dump anywhere in the tree (§0). Reporting a row's contents would mean inventing one.

What is established: a live `delivery_jobs` row has **27 columns** — the 26 of the base DDL
(`database.js:5066-5094`) plus `superseded` (`:5103`) — and **not one of them is money**.
Nothing named `fee`, `cost`, `price`, `amount` or `charge` has ever existed on the table. So the
only place a Qingyun fee could be hiding in a live row is **inside the `raw_order` JSON text**,
and §B2 is the full extent of what can be said about that without opening the database.

**The single query that would settle B2 and B3 together, stated as the missing measurement and
nothing more:** read `raw_order` from one recent dispatched row and look for a fee key. It is a
read-only `SELECT` against a database this container does not have.

---

## C — Summary of the five questions

| # | Question | Answer |
|---|---|---|
| 1 | JD endpoints and whether responses carry a price | **Seven call sites, six live endpoints across two gateways** (§A1). None returns a readable charge. The `pullData` label blob is **encrypted and forwarded unread** — the only JD payload that could hold a price. The full response shape is **uninspectable**: the envelope is discarded at `lib/jd.js:154`, narrowed again at `:259`, and the one diagnostic log prints only the innermost object. |
| 2 | A JD pricing/quote/billing endpoint we don't call | **None revealed.** No JD API document exists in the repository; the module's own workflow map has no pricing step; the account's JOS subscription list — the actual authority on what is callable — is not in the tree. Open question, not answerable here. |
| 3 | When JD's charge becomes known | **At no point in anything we call.** Not at creation, not at print (encrypted), not at trace, not at cancel or intercept. And every waybill declares a **hardcoded 1 kg / 100 cm³**, so no creation-time figure could have been real. A cost cannot be written at waybill time from a JD-supplied number, because there is none. |
| 4 | Do we retain raw JD responses (cf. `eleme_order_import`) | **No.** No `jd_*` table, no raw column, no sync log — stdout only, envelope already stripped. Nothing to name, and no row to check for a fee. |
| 5 | Qingyun: quoted vs settled, and `raw_order` | **They can differ, by five mechanisms**, one of which (a second, independent re-quote at `routes/retail.js:25056`) fires on **every** dispatch; on a concurrent dispatch the settled fee is never even displayed. The settled truth is the **prepaid wallet ledger**, which nothing reads. `raw_order` is **write-only, never read by any code**, holds the `order/list` entry truncated at 20 kB, and whether a settled figure is inside is **unmeasured** — this survey could not open a database. |

**One correction to the prior survey, offered because it changes what "JD has no price field"
means.** `docs/tacet-courier-cost-survey.md` §A2 is accurate that `lib/jd.js` contains no
fee/cost/price/freight/amount identifier. But it concluded from that "a logistics API surface
with no billing surface." The stronger and more useful statement is narrower: **we have never
looked.** The JD envelope is discarded before any code or human can see it, and the one payload
that most plausibly carries a price is encrypted and passed through untouched. The absence of a
price field in our code is evidence about our code, not about JD's API.
