# Tacet delivery vocabulary — locked

**v1.31 · 2026-09-07 · AMENDS *Affiliate reward notification — the mini app inbox* with the admin toggle row, locking TWO more entries, ONE REUSED AND ONE COMPOSED.** It serves `docs/tacet-consolidation-decisions.md` §62's second amendment: a tenant can now switch the affiliate reward notification off from Marketing → Broadcasts → Automatic updates, the same folded panel that already toggles Order/Invoices/Refunds — no server code changed, because `notifyCustomer()`'s category mute was never hardcoded to those three. **The row's title is the SAME `邀请奖励` pair this section already locks for the notification itself and the category chip** — a fourth reuse of one pair rather than a fourth string for one concept. **The subtitle is COMPOSED, on the sibling Invoices row's own shape** (`Sent when an invoice is issued for an order · 订单开具发票时发送`), reusing `发送` and this section's own `到账`, with `邀请人` — the affiliate page's own live word for the referrer (`referredByLabel`) — naming who receives it. Composed under Rule 4's standing delegation. Rules 1 to 7 are unchanged. v1.30 · 2026-09-07 · adds an amendment section, Affiliate reward notification — the mini app inbox, locking THREE entries, ALL COMPOSED FROM LIVE FRAGMENTS.** It serves `docs/tacet-consolidation-decisions.md` §62: the affiliate ledger's Waiting → Rewarded flip now tells the referrer, automatically, through the mini app's own in-app inbox — the same `retail_notifications` path refund/invoice/feedback events already use, never a new push channel and never the operator-composed `retail_broadcasts` campaign feature, which this event does not fit (one recipient, decided by an order paying, not by an admin composing anything). **Nothing lived for "your reward has landed" as a sentence, but every WORD in it did** — the title's lead clause `已到账` is the same clause this document already locks on the refund-paid pair, and `邀请` / `奖励` / `完成首单` / `你得 ¥{amount}` / `钱包` are all lifted from the affiliate page's and the wallet page's own live copy, so what is composed is the sentences that put them together and not the vocabulary inside them. The category chip reuses the title's own CN half rather than minting a second string for the same concept. One live candidate — the affiliate page's own section title `收获奖励` — was considered for the notification title and rejected, because it names a whole section of that page rather than one credited event. Composed under Rule 4's standing delegation, with the usual correction caveat. Rules 1 to 7 are unchanged. v1.29 · 2026-09-07 · EXTENDS *A batch that could not be matched to a shelf* with FOUR MORE PAIRS, ALL COMPOSED, for the refusals that used to say nothing at all.** It serves `docs/tacet-consolidation-decisions.md` §59 as amended a third time: every path out of the kitchen queue that does not reach the record screen now names itself on the queue it drops back to. **No section is opened, because these are the same screen's remaining states** and a reader looking for what the handover says should find all of it in one place. **The lead clause is REUSED, not re-minted** — `但库存尚未登记` is the clause v1.28 locked one section-entry above, and `已标记完成` is live in both files — so what is composed is three reason clauses and the sentence that carries them. **`登记生产批次` IS QUOTED FROM `lib/capabilities.js`, and quoting it is the point of the string**: it is `production:log`'s own label, the words an admin reads on the permissions screen, so an operator who is refused can ask for the right thing by name instead of reporting a blank screen — a refusal that names a capability in different words from the screen that grants it sends two people hunting. `此账号无法…` follows the live refusal pattern already in both files (`此账号无法处理厨房队列。`). **The rejected alternative is recorded**: a single generic sentence for all three refusals was considered and dropped, because the three are acted on by three different people — an admin grants the permission, an owner adds the store, and the person who raised the request fixes its quantities — so one sentence would tell none of them what to do. Composed under Rule 4's standing delegation, with the usual correction caveat. Rules 1 to 7 are unchanged. v1.28 · 2026-09-07 · adds *A batch that could not be matched to a shelf*, locking SIX entries of which FOUR ARE COPIED VERBATIM AND TWO ARE COMPOSED.** It serves `docs/tacet-consolidation-decisions.md` §59 as amended a second time on 2026-09-07, which stops the kitchen queue's handover refusing on a shelf that has merely not loaded yet and on lines it cannot match. **The screens gained two states they had never had — waiting, and a shelf that failed — because until now they had refused to open at all in both, which is the defect.** `加载中…`, `货架加载失败。`, `重试` and `登记批次` are all live in the same two files and are taken verbatim; **what is composed is one CLAUSE and the two sentences it sits in**, and the clause is `但库存尚未登记` — *but nothing has been added to stock yet*. **No live pair says it**, because no screen in this product has ever had to tell somebody that a step they just completed left the stock untouched: the request closes and the shelf is still short, which is the whole gap §59 exists to close. **One live pair is REJECTED and the rejection recorded**: `Stock pending · 库存待扣`, §58's operator note, is the closest live string about stock that has not moved and is not taken, because `待扣` is stock waiting to be DEDUCTED by an order leaving and this is the opposite direction — units that were MADE and have not been added — so reusing it would put the deduction vocabulary on a production write. **The live `货架加载失败。` alone was also considered and is kept as the opening clause rather than as the whole message**, because it names what failed and not the two facts the operator has to act on: the request is already closed, and there is no way back to it. Composed under Rule 4's standing delegation and carrying the usual correction caveat. Rules 1 to 7 are unchanged. v1.27 · 2026-09-07 · AMENDS *Typing a batch into Add stock* IN PLACE — the control moved from a sheet to the count cell itself, and NOT ONE STRING IS MINTED OR RE-TRANSLATED BY IT.** It serves `docs/tacet-consolidation-decisions.md` §60, which rules that a kitchen types its batch on the card and a recount keeps the sheet. The three pairs v1.26 locked change only which element carries them — title to `aria-label`, confirm button to card button, validation line unchanged — and `Quantity · 数量` is **RETIRED on this screen** and recorded as retired rather than struck out, because it stays live elsewhere in `public/m.html` and the reason it went is worth keeping: a field with the count already in it, on a card naming the product, leaves a label above it nothing to say. **The amendment is written into the v1.26 section itself rather than opening a new one**, since a section about a screen whose control has been replaced is misleading read alone. Rules 1 to 7 are unchanged. v1.26 · 2026-09-07 · adds *Typing a batch into Add stock*, locking FOUR entries of which THREE ARE COPIED VERBATIM AND ONE IS COMPOSED — and the ratio is the whole point.** `public/m.html`'s Add stock card let a count be TYPED in recount mode and not in add mode, so a kitchen logging 130 bowls of soup tapped `+` a hundred and thirty times; `public/stock.html`, the sibling kept 1:1 with it, has opened its keypad from the count in both modes since that screen existed. **Giving add mode the door recount already had needed almost no new words, because the sibling had already written them**: `How many did you make? · 制作了多少?` and `Add to stock · 加入库存` are that keypad's own label and save verb, taken verbatim — the first is the very pair the v1.21 section built `在架有多少?` parallel to — and `Quantity · 数量` was already live in this file. **The single COMPOSED pair is the live validation sentence with one noun swapped**, on the `statStripEmpty` precedent: `请输入在架数量——整数，0 或以上。` keeps its structure, its em-dash break and its whole tail, and only `在架数量` becomes `制作数量`, where `制作` is the page's own live word. **Two live candidates are REJECTED and both rejections recorded**: `请输入到货数量 — 0 或以上的整数。`, the closest live sentence by shape, because `到货` is goods arriving from a SUPPLIER and a kitchen that cooked the soup received nothing — the same class of collapse §46 prevents between a batch and a recount; and `每家门店请输入 0 或以上的整数。`, whose qualifier names a per-store grid this one-product field is not. **The section also records what carries NO string:** the count gained a visible edge so it can be told from the label above it, and no words, because a numeral needs no label. Rules 1 to 7 are unchanged. v1.25 · 2026-09-07 · adds *The two doors into a shop — the till and the QR menu*, locking TWO entries, BOTH COMPOSED.** It serves `docs/tacet-consolidation-decisions.md` §44 as amended 2026-09-07, which names `retail_orders.shop_entry_method` — values `till` and `qr` — as the column that tells a shop's two doors apart, and NOT `retail_orders.source`. **Nothing could be copied, and the reason is structural rather than an oversight**: no screen in this product has ever had two doors into one shop to name, the web store and the mini app each having exactly one way in and the till having been the only way into a counter until the QR menu existed. **Every TERM in both sentences is nonetheless live** — `门店` from the shop channel's own label, `前台` from the `前台销售` refusal already locked in the very map these two join, `二维码` from the admin's share-card and payment-code panels — **so what was minted is the sentences and not the words.** **Two live candidates are REJECTED and both rejections recorded**: `Shop menu · 门店商品`, the closest live pair to "the QR menu", because it names the ADMIN's shop-listings editor and would make one string mean two screens; and `请选择订单来源。`, the nearest live sentence, because it asks for an ORIGIN — how the customer reached the business — and §44 is explicit that a shop's door is not an origin. **Three server codes share the two sentences**, on the house precedent of `bad_fulfillment_type` and `fulfillment_type_required` sharing theirs in the same map. **The cost is named rather than hidden**: neither sentence is reachable from the New order form, which offers no `shop` channel and sends no door, so both are locked for a state nobody can currently reach — bought because the endpoint serves other callers and because `verify-fulfilment-types.js` fails the build over a server error with no home on the page. Rules 1 to 7 are unchanged. v1.24 · 2026-09-06 · adds *The kitchen's printed request slip*, locking twenty-one entries of which FIFTEEN ARE ALREADY LIVE AND SIX ARE COMPOSED — and the ratio is the section's point.** It serves `docs/tacet-consolidation-decisions.md` §51, which rules that a kitchen request prints on paper when it reaches the production queue. The product has been announcing those requests for months and printing receipts for longer, so the slip's headers come from the push it is the paper twin of, its body from the kitchen's own request screen, and **every string on the new reprint button from the PHONE'S reprint control, which has said all of this for a receipt since long before the kitchen had a printer** — `打印中…` and `打印机没有接收。请检查是否开机、有纸。` verbatim, both halves. **One live pair is deliberately REJECTED and the rejection recorded**: `Reprint receipt · 重打小票` is the closest live string to the new button and is not taken, because `小票` is a receipt — a priced document handed to a customer — and this slip is a production ticket carrying no money anywhere; the verb `重新打印` is still lifted rather than minted, with the noun dropped because the button sits inside the request's own screen. **The six composed pairs are ALL in the settings block**, and the reason they are the only ones is that a when-does-it-print chooser is the one thing this product has never had to describe — the store printers print when an order is paid, and there was never a second moment to choose between. They carry the usual correction caveat. Rules 1 to 7 are unchanged. v1.23 · 2026-09-06 · adds *Paying on the QR menu — in-page WeChat*, locking three entries of which TWO ARE COPIED VERBATIM AND ONE IS CUT DOWN FROM A STRING THIS DOCUMENT ALREADY LOCKS.** It serves `docs/tacet-consolidation-decisions.md` §50, which rules that the QR menu takes a WeChat payment in the page and sends Alipay to the till. `微信支付` and `支付成功！` are the web storefront's own checkout and payment-success strings, taken verbatim so the customer paying at a counter meets the words they met online. `收银台付款` is **COMPOSED** under Rule 4's standing delegation by removing the request and the full stop from the locked `请到收银台付款。` — a button is a label rather than an instruction — and it records the rejected alternative, reusing the locked sentence unchanged, which would have put a full stop inside a button and left the two indistinguishable in a search. **The section also records what carries NO string:** every failure on the payment page renders the placed-order screen with the already-locked `orderPlaced` and `payAtCounter`, because §50 ends all of them at the till, and four bespoke failure sentences would tell a customer in a queue four things they cannot act on. Rules 1 to 7 are unchanged. v1.22 · 2026-09-06 · adds *The About page editor*, locking seven entries of which FIVE ARE ALREADY LIVE AND TWO ARE COMPOSED.** The editor at retail-admin → About page stopped supplying its own Chinese: until audit D-04 it arrived pre-filled with the first tenant's About page, bilingual, and a merchant who pressed Save wrote that copy into their own shop. Emptying the form is what created the need for any new string at all — an empty stat strip needs an add button and a note saying what empty means, and a full one never did. `添加数据项` and `留空则隐藏数据条。` are **COMPOSED** under Rule 4's standing delegation; the first records the live candidate it REJECTED and why, since `添加「是」项` and `添加「否」项` sit in the same block and the literal copy of their shape says *add a stat-STRIP item* with three nouns stacked and an empty bracket where a one-character value belongs. The section also records what deliberately carries NO new string: the four placeholders D-04 removed are not replaced by composed neutral twins, because each field already has a label naming it. Rules 1, 2, 3, 5, 6 and 7 are unchanged. v1.21 · 2026-09-06 · adds *Quick stock — the count keypad and the drop fork*, locking fifteen entries across `public/stock.html` and `public/m.html`, ONE COPIED VERBATIM AND THE REST COMPOSED.** A shop operator reported the Quick stock screens (加库存) reading English on `杏仁酱`'s card and inside its correction dialogs — the two files' `tBlocked()`/`TB()` escape hatch, described in `docs/tacet-quick-stock-addendum.md` §8, had never been resolved for either sibling. Composed under Rule 4's standing delegation rather than left blocked, since the amendment's whole point is that whoever is building does not have to stop and wait. Most rows reuse a live pair or a live word from elsewhere in the SAME two files — 在架 from `public/m.html`'s own shelf-figure label, 校正 from the `Correction` ledger reason, 记录损耗 from the live `Record waste` control — rather than mint independent Chinese for a concept the product already names. **`Something is missing or spoiled` stays deliberately generic in both languages** — it does not borrow a `WASTE_REASONS` word (`变质`, `损坏`, …) because the button beside it is documented as NOT a reason picker. None of this has been shown to Ash; every row carries the usual correction caveat. Rules 1 to 7 are unchanged. v1.20 · 2026-09-06 · adds *The counter basket — the QR menu*, locking ten entries of which EIGHT ARE COPIED FROM LIVE STOREFRONT CODE and only two are composed.** It is the first section about a customer ordering from a surface inside a shop, and the ratio is the point: the person buying online and the person at the counter are the same person, so *add*, *basket*, *total*, *place order*, *order placed* and the order-number label are all the web store's own words rather than second copies. `请到收银台付款。` and `请重试。` are **COMPOSED** under Rule 4's standing delegation and marked as such — the first because no surface in Tacet has ever had a counter to walk to, the second because the live failure copy is all cause-specific and none of it fits a dropped connection. The section also records what carries NO string: the add, quantity and close controls, and the placed order's number and name. Rules 1, 2, 3, 5, 6 and 7 are unchanged. v1.19 · 2026-09-06 · RULE 4 IS AMENDED — the delegation becomes STANDING, and it is the first time a rule in this document changes rather than gaining a section.** Ash ruled that whoever is building decides the Chinese, rather than stopping and asking; the preferences (copy a live pair, lift from the source, compose) keep their order and only the last one's status moves, from last resort to ordinary outcome. **What is NOT delegated is composing silently** — every composed pair is still written here, marked as composed and by whom, in the same commit as the code that uses it, on this document's own v1.17 reasoning that the failure was never the composing. PROVISIONAL is retained and narrowed to concepts that are still unsettled, rather than to strings a machine chose. Opens its first exercise, *The number a shop calls (§49)*, locking one pair — `Pick-up number` · `取餐号` — with the two live candidates it rejected recorded so the search is not repeated. Rules 1, 2, 3, 5, 6 and 7 are unchanged. v1.18 · 2026-09-04 · adds a TWELFTH amendment section, What a material line's Arrived box does — receiving, locking one pair. IT IS THE FIRST SECTION ABOUT A CONTROL THAT IS CORRECT AND LOOKS BROKEN: a material line's Arrived box drives Finance and never stock, and the In-stock cell beside it shows an em dash for ever, so the two together read as *the number you typed did nothing* — which is how that box came to be proposed for deletion, tried and reverted on 2026-08-27. The pair sits on BOTH cells, because either alone leaves the other still saying it, and product rows carry none of it, since on them the sentence would be false. Its CN half is composed under the fourth amendment's delegation and every clause of it is quoted from the screen the tooltip sits on; per v1.17's process point it is DECLARED HERE AS COMPOSED rather than presented as locked-by-Ash, and he should correct it if it reads wrong. Rules 1 to 7 are unchanged. v1.17 · 2026-09-03 · SIX STRINGS THE CHINESE ARTBOARDS WERE ALREADY USING ARE BROUGHT UNDER LOCK, MARKED COMPOSED-THEN-CONFIRMED RATHER THAN OPERATOR-SUPPLIED.** `已收货`, `件已入本店库存`, `共 N 项`, `今天`, `返回库存` and the closing sentence `三项均已记入本次收货，仓库可以看到。无需您再做任何操作。` were written to build `ReceivedZH` and shown to Ash afterwards; he has seen them and they stand. **They sit in their own table, not folded into the receiving one, because a reader must be able to tell the two provenances apart at a glance** — everything above came from Ash as the operator or was translated on his explicit instruction. `共 N 项` had ALREADY BEEN SHIPPING in `MainZH` before `ReceivedZH` was drawn and went unflagged then too; it is recorded with this block rather than tidied into the table above, because its provenance is the same. **THE PROCESS POINT MATTERS MORE THAN THE SIX STRINGS: composing Chinese is not the failure — Rule 4's amendment route exists for exactly that — composing it SILENTLY is.** `ReceivedZH` was reported as blocked on three strings and then built with nine. When a new screen needs Chinese beyond what is locked, every new string is listed in the report AT THE TIME IT IS WRITTEN, before the commit rather than after someone reads the diff: an undeclared string cannot be reviewed, cannot be marked provisional, and looks identical to a locked one to everyone who comes after. Three Chinese SOURCE COMMENTS are also named there — they render nothing and are exempt, but they were composed in the same pass. Rules 1 to 7 are unchanged. v1.16 · 2026-09-03 · THREE MORE ENTRIES IN THE ELEVENTH AMENDMENT'S RECEIVING TABLE — `申请`, `实收` and `与申请对比` — TRANSLATED WITH ASH'S EXPLICIT PERMISSION AND LOCKED.** They serve the `Received` screen's two-gap line, which states what the store asked for, what the warehouse sent and what she counted; they opened as PROVISIONAL under v1.14 with their Chinese halves deliberately left empty, and they close here rather than being quietly promoted. `申请` matches the already-locked `补货申请`, so ONE WORD CARRIES FROM THE REQUEST THROUGH TO THE RECEIPT; `实收` is the standard logistics term for the quantity actually received and shares `收` with `多收`; the three read together as `申请 18 · 发出 14 · 实收 10`, in the order the goods moved. **`实收` IS THE OUTCOME QUANTITY AND MUST NOT COLLAPSE ONTO `点数` OR `项已点`** — `收` is the outcome, `点` is the act of counting, so `点数` stays the CONTROL that opens the keypad and `项已点` the progress tally. The Chinese `Received` artboard was blocked on these and is now drawn; nothing shipped English-on-both-sides in the interval. Rules 1 to 7 are unchanged. v1.15 · 2026-09-03 · ASH RULES ON THE `短少` / `短缺` COLLISION: `短少` IS THE SINGLE CHINESE WORD FOR *SHORT* PRODUCT-WIDE, AND `短缺` IS RETIRED.** The v1.14 banner recorded the collision unresolved; this closes it. The fourth amendment's per-product-lines note, which endorsed `短缺`, is marked historic in place under the convention this file already uses for a superseded note (`**AMENDED …** The note above is now historic:`, as the recipe-line-units section does) — **the note is not deleted, and only its Chinese half moves**: the pair stays `${n} short` / `${n} 短少`, still reused from the purchasing screen rather than re-minted, so its Rule 6 reasoning is untouched. **THIS RULING DOES RETROFIT LIVE CODE, against this document's usual habit** — every `短缺` in the product is swept to `短少` in the same ruling, because two words for one condition on two screens about the same delivery is precisely the defect Rule 1 exists to prevent, and a lock claiming to have settled it while the screens still disagreed would be a lie. Rules 1 to 7 are unchanged. v1.14 · 2026-09-03 · adds an ELEVENTH amendment section, Stock movement — picking and receiving, locking sixteen entries across two screens. CONFIRMED BY ASH DIRECTLY AS THE OPERATOR, so they carry no "Ash should correct these" caveat and are the locked source everything else copies from.** It is the first section about stock moving BETWEEN OUR OWN BUILDINGS: every table before it covers goods arriving from a supplier, an order leaving for a customer, or money, and these cover a warehouse picking a shop's request and that shop counting what turned up. FIVE CONFLICTS WITH LIVE STRINGS WERE FOUND AND ARE NOT RESOLVED HERE — `短少` against purchasing's `短缺` for the same English word (this document blesses both, at the fourth amendment's per-product-lines note and in this section), `确认收货` already carrying three different English partners, `全部门店` live as *All stores* against this section's *All shops*, `来自仓库` live as *From warehouse*, and `扫码` live as *Scan QR*. **Nothing live is retrofitted and neither side is changed** — they are recorded for Ash to rule on, because a vocabulary lock and a sweep of shipped screens are never the same commit. Rules 1 to 7 are unchanged. v1.13 · 2026-09-02 · adds a TENTH amendment section, Unit cost sanity warning — the product editor, locking one pair: `sellingBelowCost`, ADOPTED FROM LIVE CODE rather than minted.** The pair — `selling below cost` · `低于成本销售` — was already shipping at `public/retail-admin/09-products.js:1306` before either half of it existed in this document's tables, so locking it closes this document's own gap rather than composing a second string for the condition it already named. It backs `docs/tacet-consolidation-decisions.md` §36, *Unit cost exceeding sell price now warns* (2026-09-02): Tacet warns, and does not refuse, when a product's typed cost exceeds its sell price — the finding behind it is product 3 (Jackfruit Chips), ¥990.00 cost against ¥19.20 price, sitting unremarked. Confirmed by Ash, 2026-09-02. Rules 1 to 7 are unchanged. v1.12 · 2026-09-02 · adds a NINTH amendment section, Channel money breakdown — the fees a platform charges, locking five entries: THREE LIFTED FROM THE CHANNEL and TWO COMPOSED AND MARKED PROVISIONAL.** It is the first section opened under the *when no locked source exists* amendment recorded the same day in `docs/tacet-consolidation-decisions.md`, and it exercises two of that amendment's three preferences in one table. `顾客配送费`, `商家对顾客的活动补贴` and `预计收入` are **Meituan's and Eleme's own merchant-screen wording, copied verbatim**, with the platform each came from recorded beside it — preference 1, which treats a platform's own screens as a locked source for its own vocabulary. `明细不完整` and `结算明细` name nothing any platform displays and were needed before an operator could be asked, so they are **composed under preference 3, marked PROVISIONAL, and carry a review debt**: a native operator reviews them before the feature leaves beta. **A composed string that is not marked provisional is a rule violation regardless of whether it turns out to be correct** — these are marked. Rules 1 to 7 are unchanged. v1.11 · 2026-09-02 · adds THREE pairs for the Transactions WRITE half — the form that types a ledger row, and the confirm before one is deleted. Confirmed by Ash 2026-09-02, his own words, no "Ash should correct these" caveat. **Only three were needed, and that is the point:** everything else the form says is REUSED rather than minted — `routes/finance.js` already ships `date required · 日期必填`, `amount must be positive · 金额必须大于零` and both PO refusals in this same domain, the confirm body's second sentence `This cannot be undone. · 此操作无法撤销。` is live in the product editor, and Save, Cancel, Delete, Date, Amount, Category and Note are live across the admin. **A pair is minted only where no live source says the same thing about the same object** — the house confirm pattern `确定删除该…？` being live is not enough, because it carries no noun for a ledger row. v1.10 · 2026-09-02 · EXTENDS the Finance section's table with THIRTEEN pairs for the Transactions screen, plus one reused control label recorded so its pairing is explicit rather than inferred. No new section: Transactions is the second Finance sub-view and its words belong beside the staircase's, in the table the eighth amendment opened. **Confirmed by Ash 2026-09-02, his own words rather than minted under the fourth amendment's delegation, so they carry no "Ash should correct these" caveat and are the locked source everything else copies from.** THREE NOTES STAND ON THEM. **`moneyIn` is `进账`, NOT `收入`** — `收入` is reserved for Income, a different thing in Tacet, and ruling 1 already keeps it away from Revenue for the same reason; the two must never collapse, because a screen that used it would lose the distinction in exactly the half most operators read. **`moneyOut` is `支出`, already live as a generic expenses label, and the reuse is deliberate** — on Transactions it means precisely that, so a second word for it would be the invention. **`categorySubtotals` vanishes entirely at n = 1 and the pair exists for n greater than 1 only**, per §36: when nothing was collapsed a note asserting a breakdown sends the operator hunting for one, and it must not read "1 category" either — absence is the rendering at one, not a shortened string. It is also INTERPOLATED and must not be glued, on the same §1.11 terms as `excludedCosts`, though as a count rather than a money figure it carries no currency caveat. **`transactionsEmpty` names typed rows and purchase-order postings and never orders**, because §36 v4.118 settles that Transactions lists `income_entries` and `expense_entries` and does not list the order record — the empty state has to name what will actually arrive. **`noMatchingRecords` ships alongside it because §1.12 requires both states**: empty and no-results are different sentences, and a screen that filters ships both. v1.9 · 2026-09-02 · adds an EIGHTH amendment section, Finance — the money staircase, locking eight pairs and two sentences. It is the first section in this document that is not about goods or their movement: every table before it covers a parcel, an order, a delivery or a shelf, and these cover MONEY — the five lines of the Finance Summary staircase, the words beneath them, and the two sentences the screen says when a figure is not there. The document's scope widens by it; Rules 1 to 6 are unchanged. It is also the first section whose pairs are Ash's own words rather than minted under the fourth amendment's delegation, so it carries no "Ash should correct these" caveat and is the source everything else copies from. THREE COLLISIONS made it an amendment rather than a copy, each a word already live and close enough to reach for: `毛利` is Margin (`09-products.js:1312`) and gross profit is therefore `毛利润`, one character apart and deliberately so; `总营收` is gross REVENUE (`app.html:21252`), a third meaning again; and Revenue itself ships as FOUR different Chinese strings today — `营收`, `收入`, `本月营收`, `总收入` — so there was no pair to copy because there were four. `营收` is the ruling, and `收入` is explicitly not a synonym: Finance keeps Income for a different thing. **Contribution must never collapse onto Net's pair** — §36 makes Contribution the guard word for a per-location figure that has NOT had business-wide costs taken off, so merging the two would keep the distinction in English and lose it in the Chinese view. The not-recorded sentence NAMES NO DATE, against §1.12's usual instruction to name the boundary, because §36 v4.113 records that the cost cutoff must come from a production query that has not been run; a dated form would be a new string and a new pair, never an edit to this one. **Nothing live is retrofitted here** — the four Revenue variants stay as they are, so that a vocabulary lock and a sweep of shipped screens are never the same commit. v1.8 · 2026-09-01 · adds a SEVENTH amendment section, Confirming arrival per product — receiving, locking ten pairs. It is the first section in this document to separate WHAT THE GOODS DID from WHAT THE RECORD SAYS: `未到货` is the supplier not sending, `待确认` is nobody having answered yet, and the phone's receive screen had one word for both because it opened with every line pre-filled at the quantity ordered and one button that booked all of them. Two of its pairs are reused rather than minted — the receive screen's own `未到货` and the PO sheet's `全部到货` — and the whole-order button's body no longer sends the operator to a desktop for per-product work, which stopped being true when Receive became a screen on the phone. v1.7 · 2026-09-01 · adds a SIXTH amendment section, A cost that cannot be put back — purchasing, locking three pairs. It is the first refusal in this document that names a remedy the operator can carry out: the two before it state a condition and stop, while this one ends in an instruction, because the system cannot know the old price and a person can decide it. Shipped without it, the condition reached the operator as a bare error code on a screen that had already told them to do the thing it was refusing. v1.6 · 2026-09-01 · adds a FIFTH amendment section, Purchase returns — purchasing, locking fifteen pairs on the day it opens. It is the first section about goods leaving the building in the direction they came from, and it exists because the receiving vocabulary could say SHORT and DAMAGED but had no word for SENT BACK — so a return had to be entered as a delivery that never happened. One of its reason codes reuses the mobile screen's existing `错货` rather than re-minting it, and its refusal headline deliberately does NOT reuse `undoBlocked`: same shelf test, different subject. This bump also covers the FOURTH amendment (Undo receiving clears the counts, LOCKED 2026-09-01), which landed without one — the sections below are the record, and the count in this banner is now caught up with them rather than rewritten to pretend it never slipped. v1.5 · 2026-08-27 · adds a THIRD amendment section, Receipt reversal refused — purchasing, and locks its one pair, `undoBlocked`, on the day it opens — the first entry in this document about goods ARRIVING rather than an order leaving, and the first about stock at all, which is why it needed a section of its own rather than a row in a table above. It serves three entry points that must not diverge, it must always carry both of its halves, and the per-product lines beneath it reuse a pair already live on the purchasing screen rather than minting a second copy here. Also of record: the recipe-line-unit pair WAS minted and locked 2026-08-27, as that section’s own heading says; the v1.4 note that follows still describes it as waiting on Ash and is left as written, being a dated record of that day rather than a claim about today. v1.4 (2026-08-26) adds a SECOND request section, for recipe line units, which like the first holds NO locked strings — one English string is waiting on Ash for its Chinese, bringing the pending total to seven across two sections, all unlocked until he supplies them. The concept is a recipe line counted in a unit that measures a different kind of thing than its material's stocking unit, so that line's cost cannot be worked out; two existing pairs were considered and rejected, and the section records which and why so the search is not repeated. The channel-mapping request section is unchanged (v1.3, 2026-08-26, adds it — six English strings waiting on Ash). The tables above are unchanged and remain locked by Ash as of v1.2 (2026-08-20, adds the admin form-caption table). Derived from `docs/tacet-delivery-status-survey.md` (2026-08-03). This document is a SPECIFICATION: every delivery/fulfilment word on every surface must come from these tables. The survey records what existed; this records what is allowed.**

## Rules

1. **Two registers, one word each.** The OPERATOR register covers the admin (orders list, drawer, dashboard, chips, exports). The CUSTOMER register covers the mini app, web store, notifications, the customer timeline, and the printed slip. Within a register, each state has exactly one EN string and one CN string. Cross-register differences are deliberate; within-register differences are defects.
2. **Estimates and actuals never share a label.** An estimate (promised or predicted future time) is labelled `ETA` (operator) or `Estimated arrival` (customer). A recorded event time is labelled `Arrived`. The bare word `arrival` is banned as a user-facing label — it asserts a past event and has been used for estimates.
3. **No estimate survives completion as the live line.** Once an order is delivered, cancelled or refunded, no surface may present an ETA as its primary/live state. A never-resolved ETA on a closed order may render as historical (`ETA · 预计送达`, settled grey), never as an active promise.
4. **CN strings are locked here.** Never compose new Chinese; copy from these tables. Additions require an amendment to this document. **AMENDED 2026-09-06 — see *The delegation becomes standing* below. The sentence above is left as written, per this document's convention for a superseded note.** Composing is now delegated to whoever is building, standing rather than per case; what is NOT delegated is composing *silently*. Every composed pair is still written into this document, marked as composed and by whom, in the same commit as the code that uses it.
5. **Notifications branch on fulfilment type.** A pickup customer is never told an order "shipped" or "was delivered"; a counter sale sends no shipping copy at all.
6. **Labels have one definition site.** `lib/tracking.js` owns tracking-code and scenario labels; surfaces reuse `label_en`/`label_cn` and never relabel.
7. **Pickup and counter relabels are register entries, not new states.** One status column, per-fulfilment words applied at render, from these tables only.

## Order status — operator register

| status | fulfilment | EN | CN |
|---|---|---|---|
| `pending_payment` | all | Pending | 待付款 |
| `paid` | all | Paid | 已付款 |
| `preparing` | all | Preparing | 备货中 |
| `awaiting_restock` | all | Awaiting restock | 等待补货 |
| `rider_pickup` | (Meituan mirror) | Rider coming | 骑手前往取货 |
| `dispatched` | delivery | Dispatched | 已发货 |
| `dispatched` | pickup | Ready | 可取货 |
| `delivered` | delivery | Delivered | 已送达 |
| `delivered` | pickup | Picked up | 已取货 |
| `delivered` | counter | Completed | 已完成 |
| `cancelled` | all | Cancelled | 已取消 |
| `refunded` | all | Refunded | 已退款 |

## Order status — customer register

| status | fulfilment | EN | CN |
|---|---|---|---|
| `pending_payment` | all | Awaiting payment | 待付款 |
| `paid` | all | Paid | 已付款 |
| `preparing` | all | Preparing | 备货中 |
| `awaiting_restock` | all | Awaiting restock | 等待补货 |
| `rider_pickup` | (Meituan mirror) | Rider picking up | 骑手正在取货 |
| `dispatched` | delivery | On the way | 配送中 |
| `dispatched` | pickup | Ready to collect | 可取货 |
| `delivered` | delivery | Delivered | 已送达 |
| `delivered` | pickup | Collected | 已取货 |
| `delivered` | counter | Completed | 已完成 |
| `cancelled` | all | Cancelled | 已取消 |
| `refunded` | all | Refunded | 已退款 |

Every customer-facing status map must cover all nine statuses. Printing a raw internal value to a customer is a defect.

## Courier stages (live rider)

| stage | operator EN · CN | customer EN · CN |
|---|---|---|
| `scheduled` | (suppressed in admin) | Delivery scheduled · 等待配送 |
| `awaiting_dispatch` | Finding a rider · 正在找骑手 | Finding a courier · 正在为您找骑手 |
| `heading_to_pickup` | Rider coming · 骑手前往取货 | Rider picking up your order · 骑手正在取货 |
| `in_transit` | On the way · 配送中 | On the way · 骑手配送中 |
| `delivered` | Delivered · 已送达 | Delivered · 已送达 |

`Rider coming` means exactly `heading_to_pickup` — a rider is travelling to the store. It is never used for `awaiting_dispatch` (no rider yet) or as the `rider_pickup` chip's stand-in for anything else. `En route` is retired; the word is `On the way`.

## Time labels

| kind | operator | customer |
|---|---|---|
| Estimate, in flight | ETA · 预计送达 (green) | Estimated arrival · 预计送达 |
| Estimate, order closed, never resolved | ETA · 预计送达 (settled grey) | (hidden — rule 3) |
| Customer-booked window | Booked · 顾客预约 | (slot/booking copy, unchanged) |
| Recorded arrival | Arrived · 已送达 | (timeline milestone) |
| No ETA | no ETA set · 未设送达时间 | (nothing) |
| Rider minutes | ~N min · 约 N 分钟 | ~N min · 约 N 分钟 |

Note: the drawer kicker for a recorded arrival currently reads `Arrived · 送达`; it aligns to `Arrived · 已送达`.

## Date changed after printing

When a customer reschedules an order whose receipt has already printed, a short change slip is emitted. Three terms, two of them already locked elsewhere in this document and reused unchanged.

| Role | EN | CN | Source |
|---|---|---|---|
| Slip header | Date changed | 改期 | minted 2026-08-07, Ash |
| The new date | Booked | 顾客预约 | existing — Time labels, customer-booked window |
| The superseded date | Previously | 原定时间 | existing — Plan kickers, closed-order kicker |

`改期` is **fulfilment-neutral**: one term for delivery and pickup alike. The slip states that a date moved, which is equally true of both. Do not create a pickup variant — the three-way pickup relabelling recorded elsewhere in this document is a defect, not a pattern to extend.

`原定时间` carries its existing meaning — the date that was originally set — and is reused rather than re-minted. Its EN partner on the slip is `Previously`, not the `Requested timing` used by the orders-list kicker; the kicker names a plan, the slip names a superseded value.

## Plan kickers (orders list, Delivery column)

| Condition | Kicker EN | Kicker CN | Kind |
|---|---|---|---|
| closed (dispatched/delivered/cancelled/refunded) | Requested timing | 原定时间 | historical |
| pickup | Pickup time | 取货时间 | promised window |
| batch with an arrival date | Deliver by | 送达时间 | commitment date |
| batch without one | Ship by | 最迟发货 | deadline |
| right-away | Right away | 立即配送 | — |
| ASAP / nothing chosen | Ship by | 最迟发货 (headline: Courier — ship when ready · 快递 · 备好即发) | deadline |
| customer-scheduled window | Booked | 顾客预约 | customer-chosen window |

- Batch sub-line: `made fresh · ship <date>` / `现做 · <date>发货`.
- Urgency tags: `OVERDUE · 已逾期`, `today · 今天`, `tomorrow · 明天` — suppressed once the order is closed.
- `Booked` here is the same word as the `Booked · 顾客预约` time label; a customer-chosen window uses that word everywhere. `Deliver by` is our commitment; `Booked` is the customer's choice. The bare kicker `Deliver` is retired. `Requested` (bare) is retired; `Requested timing` remains the closed-order kicker only.
- The right-away CN is `立即配送`, the live customer-facing string in the mini-app checkout slot picker (`miniapp/pages/checkout/checkout.wxml`). It is not `尽快`.

## Customer notifications (fulfilment-aware)

| status | fulfilment | EN | CN |
|---|---|---|---|
| `dispatched` | delivery | Your order has shipped | 订单已发货 |
| `dispatched` | pickup | Your order is ready to collect | 订单可取货 |
| `delivered` | delivery | Your order was delivered | 订单已送达 |
| `delivered` | pickup | Order collected | 订单已取货 |
| `delivered` | counter | (no notification) | — |

Other statuses keep their existing lines unchanged.

## Admin form captions — operator register

Captions on admin forms that state a delivery rule. The one string here predates this document — it was written into the New-order wizard before the vocabulary existed and was never covered by the tables above — and is brought under lock on 2026-08-20, after the postal-code field was made optional and the count it names changed from six to five.

| Caption | EN | CN | Where |
|---|---|---|---|
| Required fields, delivery address | All five are required for a delivery order. | 配送订单五项均为必填。 | `public/retail-admin.html`, New-order wizard address block |

The numeral is part of the string, so it is only correct while the block asks for exactly five. Adding or removing a required field means amending this row, in both languages, in the same commit as the field — a caption that counts is a caption that goes stale silently.

## Tracking codes and scenarios

The nine `tracking_status` codes and seven `tracking_scenario` entries in `lib/tracking.js` are the canon, labels included. Surfaces must render `label_en`/`label_cn` verbatim; the admin's private relabels of scenarios are defects. `已签收` remains the CN for courier `delivered` (signed for) — it is a carrier fact, distinct from the order-status `已送达`.

## Channel mapping — awaiting a Chinese source (REQUEST, not locked)

Rule 4 says never compose new Chinese and that additions require an amendment to
this document. This section is that amendment, opened rather than closed: the
six strings below are running English-on-both-sides in the product right now,
because composing their Chinese is exactly what Rule 4 forbids and no existing
pair covers them.

They came in with the Eleme and Meituan mapping-name gate on 2026-08-26
(`docs/tacet-consolidation-decisions.md` §30 rule 3, which cross-references Rule
4 here: copy from the source, never compose). The screens report a mapping name
that no channel listing carries, and refuse to claim anything when there is no
catalogue to check against.

**Ash to supply the CN column.** Filling it is five edits in the product, all of
them inside `EL_PENDING_CN` in `public/retail-admin/14-eleme.js` and
`MT_PENDING_CN` in `public/retail-admin/11-meituan.js` — one constant per screen.
Where both screens carry a key the wording is deliberately identical, so one CN
string serves both channels.

Two of these have no caller on the Eleme screen right now. `notInCat` and
`notChecked` were state words for `elStoreState`, and that classification is
being rebuilt around three groups on `claude/eleme-three-group-split-7f6d32`,
where "Name not in catalogue" becomes a reason on the row rather than a state of
its own. They are kept here and in the code so that build inherits them rather
than re-opening the question. Meituan still uses both. `noneRead` is Meituan's
alone — Eleme had a sourced pair for that case already and reuses it.

| Key | EN | CN | What it says |
|---|---|---|---|
| `notInCat` | Name not in catalogue |  | State word: this mapping holds a name no listing on this store carries. Amber. Live on Meituan; on Eleme it is waiting for the three-group build to consume it as a row reason. |
| `notChecked` | Name not checked |  | State word: a name is stored and no catalogue has been read, so the check could not run. Neutral, never all-clear. |
| `pickIt` | This name matches no listing on this store. Pick one from the list. |  | Panel line under the field, on a mapping whose stored name is not in the catalogue. |
| `reverted` | Not in the catalogue — not saved. |  | Line under the field when a typed value was refused and the field put back to what it held. |
| `cannotCheck` | The catalogue has not been read from this store yet, so this name cannot be checked — nothing was saved. |  | Line under the field when the save was attempted with no catalogue to check against. It has to carry BOTH halves: the check could not run, and nothing was saved. Not amber — the screen has no grounds to say anything is wrong with what was typed. |
| `noneRead` | no listings read from this store yet, so nothing can be checked here |  | Panel line, Meituan only: a name is stored and no listings have been scraped. Eleme's half of this reuses the pair already on that screen, `no catalogue read yet, so nothing can be matched here` / `尚未读取商品目录，无法匹配`. |

Everything else on that change reuses a pair that already exists in the admin —
`No matches` / `无匹配` and `Remove` / `移除` — and needs nothing here.

Sentence case, no exclamation marks, and `notInCat` doubles as a filter-chip
label, so it wants to stay short enough to sit in a chip beside a count.

## Recipe line units — 单位不符 · UNIT MISMATCH (LOCKED 2026-08-27)

Rule 4 says never compose new Chinese and that additions require an amendment to
this document. This is a second such amendment, opened 2026-08-26 and closed 2026-08-27.

THE CONCEPT NEEDING A PAIR. A recipe line is counted in a unit that measures a
different kind of thing than its material's stocking unit — 160 ml of an oil
stocked in grams — so that line's cost cannot be worked out and is left out of
the recipe total. The material's own cost is fine.

It arrives with the §7 addendum's refusal to convert without a stated factor
(`docs/tacet-consolidation-decisions.md` §7 addendum): volume to weight needs a
density, density is a property of the material, and there is no default. 82 live
lines across 36 recipes are in this state today.

TWO EXISTING PAIRS WERE CONSIDERED AND REJECTED, recorded so the search is not
repeated. `Order unit ≠ item buy unit · 采购单位与物料单位不一致` is PO-time and
about the BUY unit, saying nothing about a recipe line or an excluded cost.
`Recipe unit is not g / ml / pcs · 配方单位不是 克/毫升/件` is the unsupported-unit
case, but these units ARE valid — they simply measure different things. Either
would be untrue on this screen.

THREE DISTINCTIONS THE CHINESE MUST PRESERVE, because losing any one of them
turns a refusal into a defect report:

1. UNKNOWN, not missing and not zero. The cost has not gone away and is not nil;
   it cannot be worked out. A word meaning "missing" would send an operator to
   look for a price that is already there.
2. THE LINE is at fault, not the material. The material's cost is good. Copy that
   blames the material sends the fix to the wrong record.
3. The total is INCOMPLETE, not wrong. Everything shown is correct; something is
   absent from it.

WHERE IT IS USED. One string, the `.rcp-warn` pill on the Recipes record screen
(`public/retail-admin/19-recipes.js`), naming how many lines are affected. The
rollup's own blocked-reason copy needs nothing new — both BLOCK_REASON maps fall
an unmapped reason through to `This recipe's cost can't be worked out right
now. · 该食谱的成本暂无法计算。`, which is true for this case.

**THE PAIR — minted by Ash, 2026-08-27, locked.** The hold is lifted: the pill
ships, and with it the accounting change that drops 34 recipes' ingredient cost.

| Key | EN | CN | What it says |
|---|---|---|---|
| `unitMismatch` | UNIT MISMATCH | 单位不符 | The line's unit and the material's stocking unit are different kinds of quantity, so the line's cost cannot be trusted. |

CHOSEN OVER TWO OTHERS, recorded so the choice is not reopened. 无法换算
overstates — a recorded density will fix the volume↔mass cases. 待换算 implies a
remedy that does not exist for the mass↔count case.

It covers all three classes the counter flags: volume↔mass, mass↔count, and any
future dimension pair. It names the CAUSE, not the mechanism and not the fix —
see §29.

Used on the `.rcp-warn` pill on a recipe ingredient line. Note for whoever wires
it: `.rcp-warn` is a RECIPE-RECORD pill (`retail-admin.css` `#tab-recipes-record
.rcp-warn`) and there is no per-line variant of it, so the string paints once per
recipe beside the other cost warnings, not once per offending line.

**AMENDED 2026-09-01 — three more places, same pair, no new Chinese.** The note
above is now historic: a per-line variant exists (`.rcp-line-warn`), and the pair
is reused, not extended. Reuse of a locked pair in a new place needs no
amendment; this records where, so the search is not repeated.

| Where | File | What it qualifies |
|---|---|---|
| The offending ingredient row itself | `public/retail-admin/19-recipes.js` `paintLineWarns()` | Which line. The record pill names the condition once; the operator still had to guess which of eleven lines caused it. |
| The recipe save | `public/retail-admin/19-recipes.js` `rcpSave()` | The moment the line is stored. The save is never blocked and the unit is never converted — it simply stops being silent. |
| The Products list margin cell, and the product editor's cost pill | `public/retail-admin/09-products.js` `_paMarginWarn()` / `pdRecipeHealthPaint()` | That the cost the percentage is drawn from is short an ingredient — the flattering direction. |

In all four places the LABEL is this pair, copied.

**THE EXPLANATIONS — minted by Ash, 2026-09-01, locked.** The five sentences that
sit around the label shipped English on both halves and marked CN PENDING, and
that is what an operator reading Chinese actually met: a triangle, a label he
could read, and a paragraph he could not. Ash, on the live screen: "make sure
that the mouse over in chinese version its in chinese language." Drafted against
the constraints below, put in front of him string by string, and minted.

| Key | Where | EN | CN |
|---|---|---|---|
| `unitMismatchLine` | the ingredient row's tooltip (`19-recipes.js` `lineMismatchTitle()`) | This line is counted in {a} but the material is stocked in {b}. Those measure different kinds of thing and nothing is converted, so this ingredient's cost is NOT included in the recipe total. The material's own cost is fine — change the line's unit to fix it. | 本条按 {a} 计量,而该物料按 {b} 库存。两者计量的不是同一类量,系统不作换算,因此本条原料不计入配方成本。该物料本身的成本没有问题 —— 修改本条的单位即可。 |
| `unitMismatchSave` | the save toast (`19-recipes.js` `rcpSave()`) | Saved — but N ingredients are NOT included in this recipe's cost: … UNIT MISMATCH — the line's unit and the material's stocking unit measure different kinds of thing, so nothing was converted. The cost shown is incomplete. | 已保存 —— 但有 N 项原料不计入本配方成本:… 单位不符 —— 该条的单位与物料的库存单位计量的不是同一类量,系统不作换算。显示成本不完整。 |
| `unitMismatchPill` | the product editor's cost pill (`09-products.js` `pdRecipeHealthPaint()`) | — N ingredients in this recipe are counted in a unit the material is not stocked in, so their cost is left out. The cost shown is incomplete. | —— 本配方中有 N 项原料所用单位与物料的库存单位计量的不是同一类量,其成本不计入。显示成本不完整。 |
| `unitMismatchMargin` | the Products list mark (`09-products.js` `_paMarginWarn()`) | UNIT MISMATCH — this product's recipe has an ingredient counted in a unit the material is not stocked in, so that ingredient's cost is left out. The cost shown is incomplete and the real margin is lower. | 单位不符 —— 本产品的配方中有原料所用单位与物料的库存单位计量的不是同一类量,该原料的成本不计入。显示成本不完整,实际毛利更低。 |
| `costIncompleteMargin` | the same tooltip's other half (`09-products.js` `_paMarginWarn()`) | Marked "cost is not complete" — this percentage is drawn from a cost that is missing something, so the real margin is lower. | 已标记"成本不完整" —— 此百分比所依据的成本缺少内容,实际毛利更低。 |

`costIncompleteMargin` is NOT part of the unit-mismatch work and is minted here
anyway. It shipped English-only with the `cost_incomplete` tag on 2026-08-31 and
shares one tooltip with `unitMismatchMargin`; half a tooltip in Chinese is worse
than none, so the pair is closed at the same time rather than left to be
rediscovered.

**THE CHINESE SAYS 不作换算, AND THAT IS THE CAREFUL PART.** The nearest existing
string in the codebase is Materials' `That recipe unit can't be divided into. ·
该配方单位无法折算。`, and it is NOT reusable here: 无法换算 was considered and
REJECTED when the label above was minted, because it says IMPOSSIBLE and a
recorded density will one day settle the volume↔mass cases. 待换算 was rejected for
the mirror reason. 不作换算 — the system DOES NOT convert — is the §7 addendum's
own position rather than a claim about what can ever be known, so it survives the
day the density field lands. `scripts/test_recipe_unit_mismatch_warnings.js`
fails if either rejected phrasing reappears.

Each sentence keeps the three distinctions above in BOTH halves — UNKNOWN rather
than missing (不计入, never 缺少成本, which names the wrong record), the LINE at
fault rather than the material (该物料本身的成本没有问题), the total INCOMPLETE
rather than wrong (显示成本不完整). The test asserts all three on the Chinese, not
only on the English.

**HOW FOUR ENGLISH STRINGS SHIPPED UNNOTICED, so the next pair does not.** The
suite stubbed the translator to return the ENGLISH half, so every assertion
passed whether or not a Chinese half existed. Section 6 of that file now flips
the language and asserts the output CHANGED, and scans both files for the shape
the bug wore — `T(x, x)` / `cuT(x, x)`, the same variable passed as both halves.

**DO NOT CONFUSE WITH UNCONVERTED**, which is the §6 addendum's state for a recipe
with a blank serving size. Different state, different screen region, different
cause.

## Receipt reversal refused — purchasing (LOCKED 2026-08-27)

Rule 4 says never compose new Chinese and that additions require an amendment to
this document. This is the third such amendment, opened and closed the same day.
It is also the first entry here that is not about an order leaving the business:
it is about goods arriving and a receipt being taken back. The section was
created because no existing one fits — the tables above cover order delivery,
the two request sections cover channel mapping and recipe line units, and none of
them speaks about stock.

THE CONCEPT NEEDING A PAIR. A purchase receipt is reversed by asserting the goods
never arrived. That is only true while the goods are still on the shelf. Where
some have already been sold or consumed, the reversal cannot be honest, so it is
refused outright — no clamping to zero, no partial return, nothing written at
all. The operator is told which products block it and by how much.

THE DECISION IT REPORTS. `docs/tacet-consolidation-decisions.md` records the
receiving path's state; the rule this string speaks for is that a reversal tests
every line against current stock BEFORE it writes anything, and aborts before the
first write if any line would drive a count below zero. A partial reversal is
worse than a refusal, because it leaves stock and the order records disagreeing
with no sign that they do.

**THE PAIR — minted by Ash, 2026-08-27, locked.**

| Key | EN | CN | What it says |
|---|---|---|---|
| `undoBlocked` | Some of these goods have already left stock, so this delivery cannot be undone — nothing was changed. | 部分货品已出库，此次收货无法撤销 — 未作任何更改。 | Headline on a refused receipt reversal. Names the reason and states that the operation wrote nothing. |

**ONE STRING, THREE ENTRY POINTS.** It serves Undo receiving, Back to draft and
Cancel order alike. All three ask for the same thing — that a receipt be taken
back — and all three are refused on the same test, so all three report the same
fact in the same words. **They must not diverge.** Three wordings for one
condition would read as three different conditions, and an operator comparing two
screens would go looking for a difference that does not exist.

**BOTH HALVES ALWAYS, NEITHER DROPPED FOR BREVITY.** The string carries two
facts: the operation was REFUSED, and NOTHING WAS WRITTEN. Neither may be
shortened away, in either language. Dropping the first turns a refusal into a
vague complaint; dropping the second leaves the operator to guess whether the
order is now half-reversed, which is the exact anxiety the refusal exists to
prevent. This follows the same requirement `cannotCheck` carries in the
channel-mapping section above, and for the same reason.

## Undo receiving clears the counts — purchasing (LOCKED 2026-09-01)

Rule 4 says never compose new Chinese and that additions require an amendment to
this document. This is the fourth such amendment, opened and closed 2026-09-01.

HOW THE CN HALF WAS ARRIVED AT, since Rule 4 exists to stop exactly this being
waved through. Ash delegated the wording explicitly ("you decide the chinese")
rather than minting it himself, which is the owner exercising the rule, not a
route around it — but a delegated pair is still weaker than a minted one, so it
was built from words ALREADY IN THE PRODUCT rather than composed fresh:
`实收` and `破损` are the two column headers standing directly above this dialog
(`receiveRow`, public/retail-admin/16-purchasing.js), and `已收货` is the segment
name the undone delivery remains in. That is the rule's own instruction — copy
from the source — applied to the screen rather than to this document. **Ash
should correct the wording if it reads wrong to a Chinese operator; nothing else
depends on the exact phrasing.**

WHY THE STRING IS NEEDED. Undo receiving now clears `qty_received` and
`damaged_qty` on the order's lines, where it used to leave them in place. The
old behaviour left an order sitting at Sent with every ARRIVED box holding a
number, which reads as fully received — RPO-0001 went to Delivered and back
three times on 2026-08-27 and looked received for days afterwards, and was
reported as the system filling in counts by itself. An undo asserts the goods
never arrived, so the counts going with it is the honest reading, and it is the
same assertion `undoBlocked` above is built on.

WHAT THE OPERATOR MUST BE TOLD, AND WHEN. Before they confirm, not after. The
undo is already destructive of stock and says so; it is now also destructive of
the counts, and an operator who expected to re-confirm without re-entering
anything would otherwise find out by losing them. The sentence also carries the
reassurance that the receipt itself survives — `po_receipts` /
`po_receipt_lines` keep their own copy of every number, so the delivery stays
readable in Receiving.

**THE PAIR — minted 2026-09-01 by Ash's delegation, locked.**

| Key | EN | CN | What it says |
|---|---|---|---|
| `undoClearsCounts` | The arrived and damaged counts are cleared — the delivery stays in Receiving. | 实收与破损数量将被清空 —— 该次收货记录仍保留在「已收货」中。 | Second sentence of the Undo receiving confirmation. Says what the undo destroys and what it does not. |

**BOTH HALVES ALWAYS**, for the same reason `undoBlocked` carries two: dropping
the first hides what is about to be lost, and dropping the second leaves the
operator believing the delivery record is gone too.


**THE PER-PRODUCT LINES BENEATH IT ARE NOT MINTED HERE.** Each blocking product
renders under the headline using the pair already live on the purchasing screen,
`${n} short` / `${n} 短缺` (`public/retail-admin/16-purchasing.js`, the receive
toast). That pair is reused unchanged and is deliberately NOT re-minted in this
document — it already exists in the product, in context, and writing it here too
would give one string two definition sites, against Rule 6.

**AMENDED 2026-09-03 — `短缺` IS RETIRED; THE WORD IS `短少`.** The note above is
now historic: the eleventh amendment locks `短少` as the single Chinese word for
*short* across the entire product, and Ash has ruled on the collision that note
created. **The English half and the interpolation are unchanged** — the pair is
`${n} short` / `${n} 短少`, and it is still reused from the purchasing screen
rather than re-minted here, so the note's Rule 6 reasoning stands and only its
Chinese half moves. The live sites were swept in the same ruling; see the
eleventh amendment's notes for the list.

Sentence case, no exclamation marks. The em dash before the second half is part
of both strings and is not a substitute for a full stop.

**APPROVED BY ASH, 2026-08-27.** Both halves of the pair are his; nothing in this
section was composed.

## Purchase returns — purchasing (LOCKED 2026-09-01)

Rule 4 says never compose new Chinese and that additions require an amendment to
this document. This is the fifth such amendment, opened and closed 2026-09-01,
the same day as the fourth and for the same feature area.

WHY THE STRINGS ARE NEEDED. Receiving could say a delivery came up SHORT and it
could say some of it arrived DAMAGED. It could not say the thing that happens
after the door closes: 15 kg of buckwheat flour taken in on 25 August, found
wrong on 1 September, sent back to the supplier. The only way to record that was
to edit the arrived count down — which asserts the goods never turned up,
contradicts the receipt that says they did, and afterwards cannot be told apart
from a supplier who short-shipped. **Sent back and came up short are two
different facts about a supplier, and this vocabulary is what keeps them apart
on screen.** They are also two different facts about the money: a shortfall was
never billed, a return has to be taken back off a bill that was.

HOW THE CN HALVES WERE ARRIVED AT. Under the same delegation the fourth
amendment records (Ash: "you decide the chinese"), and built the same way — from
words ALREADY IN THE PRODUCT wherever the product had one:

- `退货` is the word the admin already uses for goods going back
  (`04-orders.js`, `03-dashboard.js`), and the column header is the bare noun so
  it sits beside `实收` and `破损` in the same register — two characters, no verb.
- `错货` for `wrong_item` is **not minted here**. It is the pair the mobile
  receive screen already ships (`RCV_REASONS`, `public/m.html`) and it is reused
  verbatim, per Rule 6 — one string, one definition site. It is the only reason
  code the two lists share, which is itself the point: the other four are
  reasons goods LEFT, not reasons fewer arrived.
- `未作任何更改。` in `returnBlocked` is lifted character-for-character from
  `undoBlocked` above. The two refusals rest on the same shelf test and must
  make the same promise in the same words; only the half naming the operation
  differs.

**Ash should correct any of these if they read wrong to a Chinese operator;
nothing else depends on the exact phrasing.**

**THE PAIRS — minted 2026-09-01 by Ash's delegation, locked.**

| Key | EN | CN | What it says |
|---|---|---|---|
| `returnedColumn` | Returned | 退货 | The receive table's fifth column, and the box in it. Sits beside 实收 and 破损. |
| `returnReasonPrompt` | Why? | 原因？ | Empty state of the reason picker that appears with the first returned unit. |
| `returnQuality` | Quality | 质量问题 | Return reason: arrived intact, not good enough to sell or cook with. |
| `returnExpired` | Expired | 过期 | Return reason: out of date, or too near it to use. |
| `returnOverDelivered` | Over-delivered | 多送 | Return reason: more turned up than was ordered, the surplus went back. |
| `returnNotNeeded` | Not needed | 无需要 | Return reason: ordered in error, the supplier took it back. |
| `returnBlockedTitle` | Cannot record this return | 无法登记此次退货 | Title of the refusal dialog when the shelf cannot cover the return. |
| `returnBlocked` | Some of these goods are no longer in stock, so they cannot be sent back — nothing was changed. | 部分货品已不在库存中，无法退货 — 未作任何更改。 | Headline on a refused return. Names the reason and states that the operation wrote nothing. |
| `returnedToSupplier` | Returned to supplier | 已退回供应商 | Label on the PO's Finance panel, above the value that came back off the books. |
| `returnedNetted` | already taken off the total above, dated to the order | 已从上方合计中扣除，记在采购单原日期 | The rest of that sentence. Says the money has ALREADY moved and WHICH DATE it moved on. |
| `returnsComeOffBoth` | Returned units come back off both. | 退货数量会从库存和支出中同时扣除。 | Third clause of the receive note, rendered only on an order that has a return. |
| `returnSentBack` | sent back | 已退回 | The Receiving list's own word for a return row, where a delivery row counts lines. |
| `creditDue` | credit due | 应退 | Pill on an invoice line covering more than the line is now worth. The supplier owes this back. |
| `returnedAfterInvoicing` | Returned after invoicing | 开票后退货 | Label on the Invoices strip that totals those credits. |
| `askForCreditNote` | ask the supplier for a credit note | 需向供应商索取红字发票 | The instruction beside that total. `红字发票` is the standing term for the document; it is named because nothing in this system issues one. |

**`returnBlocked` CARRIES BOTH HALVES, ALWAYS**, exactly as `undoBlocked` does
and for the reason that section gives: dropping the refusal turns it into a
vague complaint, and dropping "nothing was changed" leaves the operator guessing
whether the return half-landed — the one anxiety a refusal exists to prevent.

**IT IS NOT `undoBlocked` AND MUST NOT BE COLLAPSED INTO IT.** The two share a
shelf test, a shape and a second half. They do not share a subject: one says a
DELIVERY cannot be taken back, the other that GOODS cannot go back to the
supplier. An operator handed the wrong one goes looking for the wrong order.
That is the mirror image of the rule `undoBlocked` states for its own three
entry points — one condition, one wording — applied to a second condition.

Sentence case, no exclamation marks. The em dash before the second half of
`returnBlocked` is part of both strings and is not a substitute for a full stop.

## A cost that cannot be put back — purchasing (LOCKED 2026-09-01)

Rule 4 says never compose new Chinese and that additions require an amendment to
this document. This is the sixth such amendment, opened and closed 2026-09-01.

WHY THE STRINGS ARE NEEDED. Taking a purchase order off its placed state has to
give back what the order took, including any ingredient cost its material lines
wrote. Where nothing recorded what the cost was BEFORE the order touched it, the
transition is refused — correctly. What the operator got was the bare code
`cost_not_recoverable` in a toast, on a screen whose own advice is "return it to
draft to change it", and the purchasing wizard only opens a draft. So the code
was the end of the road: the order could not be edited, and nothing on screen
said why or what to do about it.

WHAT MUST BE SAID, AND THE ORDER IT IS SAID IN. The refusal first, then the
materials it is about, then the way out. The way out is the part with no
precedent in this document: the system does not know the old price, so a PERSON
has to decide what it should be, and setting the material's cost by hand makes
the order's write no longer the standing one — which clears the refusal by
itself. A refusal that names its own remedy is the difference between a rule and
a dead end.

HOW THE CN HALVES WERE ARRIVED AT. Under the delegation the fourth amendment
records, and built the same way — from words already shipped:
`物料` is the Materials tab's own name (`18-materials.js`), quoted in 「」 as
that screen's settings copy already quotes it (`02-settings-ops.js`), and
`未作任何更改。` is lifted character-for-character from `undoBlocked`, because
this refusal makes the same promise and must make it in the same words.

**Ash should correct these if they read wrong to a Chinese operator; nothing
else depends on the exact phrasing.**

**THE PAIRS — minted 2026-09-01 by Ash's delegation, locked.**

| Key | EN | CN | What it says |
|---|---|---|---|
| `costBlockedTitle` | This order cannot go back yet | 该采购单暂时无法退回 | Title of the refusal dialog. "Yet" is load-bearing — there is a way out, and the next lines give it. |
| `costBlocked` | These materials still carry the price this order set, and nothing recorded what they cost before it — nothing was changed. | 这些物料当前的价格仍是本采购单写入的，而系统没有记录写入前的价格 — 未作任何更改。 | Headline. Names the reason and states that the operation wrote nothing. |
| `costBlockedWayOut` | Set their price yourself under Materials, then try again. | 请先在「物料」中手动设置这些物料的价格，然后再试。 | The remedy. A person decides the price; that clears the refusal. |

**BOTH HALVES OF `costBlocked`, ALWAYS**, for the reason `undoBlocked` and
`returnBlocked` each carry two: dropping the first leaves a vague complaint,
dropping the second leaves the operator guessing whether the order is now
half-reversed.

**IT IS NOT `undoBlocked` OR `returnBlocked`.** All three refuse a transition and
all three end in the same six characters, and they are still three different
conditions: stock that has left the shelf, goods that cannot go back to a
supplier, and a price with no recorded predecessor. Only this one has a remedy
the operator can carry out, which is why only this one has a third line.

Sentence case, no exclamation marks. The em dash before the second half of
`costBlocked` is part of both strings and is not a substitute for a full stop.

## Confirming arrival per product — receiving (LOCKED 2026-09-01)

Rule 4 says never compose new Chinese and that additions require an amendment to
this document. This is the seventh such amendment, opened and closed 2026-09-01.

WHY THE STRINGS ARE NEEDED. The phone's receive screen (`public/m.html`,
`screenReceive`) opened with every line already showing the quantity ordered and
one button underneath, so the only sentence it could say was THE WHOLE ORDER
CAME. A buyer looking at a twelve-line order with one box on the step had no way
to say which box: "I only see an option to mark that all the PO arrived." The
screen now takes the answer PER PRODUCT, and a product nobody has answered is
not sent at all — it stays outstanding on the order for the van that brings it.

THE DISTINCTION EVERY PAIR HERE EXISTS TO HOLD. **Nothing arrived** and **nobody
has said yet** are different facts, and the old screen had one word for both.
`未到货` is a statement about the goods — the supplier did not send them, it is
recorded, it books a zero and takes a reason. `待确认` is a statement about the
RECORD — nothing has been claimed either way, nothing will be written, and the
order keeps waiting. A screen that renders the first where it means the second
tells the buyer their delivery is short when it has simply not been counted yet.

TWO EXISTING PAIRS WERE REUSED RATHER THAN RE-MINTED, recorded so the search is
not repeated. `Not arrived` / `未到货` is the receive screen's own pair and is
unchanged — it is now on every product as well as on the supplier. `All arrived`
takes the CN half of the PO sheet's `Everything arrived` / `全部到货`, which is
the same claim about the same goods made one screen earlier.

HOW THE CN HALVES WERE ARRIVED AT. Under the delegation the fourth amendment
records, and built the same way — from words already shipped: `到货` is this
feature's verb throughout (`未到货`, `全部到货`, `到货` on the order rows), and
`待确认` is lifted from the payments and drops queues in the same app, where it
already means "recorded nothing yet, still needs a person". `逐项收货` is the PO
sheet's own button name, quoted in 「」 as that screen quotes screen names.

**Ash should correct these if they read wrong to a Chinese operator; nothing
else depends on the exact phrasing.**

**THE PAIRS — minted 2026-09-01 by Ash's delegation, locked.**

| Key | EN | CN | What it says |
|---|---|---|---|
| `lineArrived` | Arrived | 已到货 | The per-product answer, on the product. Its counter opens at the quantity ordered; pressing it again takes the answer back. The direct antonym of `未到货` beside it, and deliberately not `已送达` (that pair is a customer's parcel reaching them, a different subject). |
| `groupAllArrived` | All arrived | 全部到货 | The same answer for one supplier's whole group, in one tap. CN reused from the PO sheet. |
| `stateNotConfirmed` | Not confirmed | 待确认 | Supplier pill: nobody has answered any of this supplier's products. NOT `未到货` — nothing is being claimed about the goods. |
| `statePartConfirmed` | Part confirmed | 部分确认 | Supplier pill: some of this supplier's products are answered and some are not. |
| `statePartArrived` | Part arrived | 部分到货 | Row pill in To receive: this order has been received in part and still has products to come. About the GOODS, unlike the two above, which is why it is `到货` and not `确认`. |
| `stillToCome` | %d of %d still to come | 还有 %d/%d 项待收 | Under a part-received order in To receive. Counts what is LEFT, which is the reason the row is in that list. |
| `nothingConfirmed` | Nothing confirmed yet. Mark what arrived, product by product. | 尚未确认。请逐项标记到货情况。 | The summary card before anything has been answered. |
| `markOneFirst` | Mark at least one product before recording. | 请先标记至少一项到货情况。 | Under the disabled record button. Says what would make it live; not a warning, and not amber. |
| `restStayOnOrder` | %d products not answered yet — they stay on this order for a later delivery. | 还有 %d 项未确认 —— 将保留在本单，可在下次到货时收货。 | The last line of the summary. States what the save does NOT say, so a part-confirmed delivery does not read as one that dropped the rest. |
| `stillToComeShort` | %d still to come | %d 项待收 | On the confirmation screen after a part delivery, beside the counts that were recorded. |

**`restStayOnOrder` MUST CARRY BOTH HALVES** — what is unanswered, and that it
stays. The first half alone reads as an accusation of unfinished work; the
second is the promise that makes leaving products unanswered safe to do.

The whole-order button on the PO sheet keeps its title `Everything arrived?` /
`全部到货了吗？` and now names the other way in its body: `If only some of it
came, close this and use Receive line by line — you can mark each product on
its own.` / `如只到了部分商品，请返回并使用「逐项收货」，可逐项标记到货情况。` It used
to send the operator to a desktop for per-line work, which stopped being true
when Receive became a screen on the phone.

Sentence case, no exclamation marks. `%d` marks a number the screen fills in; the
EN halves take a plural `s` on their nouns and the CN halves do not.

## Finance — the money staircase (LOCKED 2026-09-02)

Rule 4 says never compose new Chinese and that additions require an amendment to
this document. This is the eighth such amendment, opened and closed 2026-09-02.

**It is the first section here that is not about goods or their movement.** Every
table above covers a parcel, an order, a delivery or a shelf. These pairs cover
MONEY — the five lines of the Finance Summary staircase
(`docs/tacet-consolidation-decisions.md` §36), the words beneath them, and the
two sentences the screen says when a figure is not there. The document's scope
widens by this section; Rules 1 to 6 are unchanged and still bind.

WHY THE STRINGS ARE NEEDED. The Finance Summary screen was specified in §36 and
mocked up in `reference/finance-summary-mockup.html`, and the build stopped on
this document: **not one of the staircase's own words had a pair.** `Cost of
goods`, `Gross profit` and `Contribution` existed nowhere in the repository in
either register, and the words that looked closest already meant other things.
An English-only Finance screen was not an option — it is the screen that says
whether the business made money — and composing the Chinese is what Rule 4
forbids. So the build stopped and these were put to Ash.

THE THREE COLLISIONS THAT MADE THIS AN AMENDMENT RATHER THAN A COPY. Each is a
word already live in the product, close enough to reach for and wrong to reuse.

- **`毛利` is Margin, not gross profit.** It is live as the Margin label in
  `public/retail-admin/09-products.js:1312` and must stay free. Gross profit is
  a total for a period; margin is a rate on a product. One character of
  difference in the pair (`毛利润`) keeps two figures apart that an operator
  would otherwise read as the same claim about the same money.
- **`总营收` is gross REVENUE, a third meaning again.** It is live at
  `public/app.html:21252` under the English `Gross`. A staircase whose second
  line borrowed it would have `Gross` naming revenue at the top and profit in
  the middle.
- **Revenue already ships as four different Chinese strings** — `营收`, `收入`,
  `本月营收` and `总收入`. There was no pair to copy because there were four, and
  a build would have picked whichever it read first.

**THE RULINGS.**

1. **Revenue is `营收`.** `收入` is NOT a synonym here: Finance uses **Income** for
   a different thing, and the two must not share a Chinese half.
2. **Gross profit is `毛利润`, never `毛利`.** See the collision above. `毛利`
   stays Margin's and is not to be taken.
3. **Contribution must never collapse onto Net's pair.** The distinction between
   the two is the whole reason the line exists — §36 makes Contribution the
   guard word for a per-location figure that has NOT had business-wide costs
   taken off, and Net the word for one that has. Merge the pairs and the
   distinction survives in English and dies in the Chinese view, which is the
   half of the product most of its operators read.
4. **The not-recorded sentence names no date, deliberately.** §1.12 of
   `docs/tacet-desktop-patterns.md` says the seventh state names when its
   boundary falls; §36 v4.113 records that the cost cutoff must come from a
   production query that HAS NOT BEEN RUN, and that the commit date must not be
   quoted as one. Until that query is run there is no date to name, and a
   sentence that guessed would be a false boundary in a locked string. **If a
   dated form is wanted later it is a NEW string and a NEW pair, not an edit to
   this one.**

**THE PAIRS — confirmed 2026-09-02 by Ash, locked.** Unlike the fourth through
seventh amendments, these were not minted under delegation and carry no "Ash
should correct these" caveat: they are his own words and are the source
everything else copies from.

| Key | EN | CN | What it says |
|---|---|---|---|
| `revenue` | Revenue | 营收 | Staircase line 1. What the business took. NOT `收入`, which Finance keeps for Income. |
| `costOfGoods` | Cost of goods | 销货成本 | Staircase line 2. What the goods sold in the period cost to buy or make. |
| `grossProfit` | Gross profit | 毛利润 | Staircase line 3, the first conclusion. `毛利润`, not `毛利` — see ruling 2. |
| `operatingExpenses` | Operating expenses | 营业费用 | Staircase line 4. The hand-entered half of the staircase; everything above it is calculated. |
| `net` | Net | 净额 | Staircase line 5, unfiltered. Business-wide costs HAVE been taken off. |
| `contribution` | Contribution | 贡献毛利 | Staircase line 5, filtered to one location. Business-wide costs have NOT been taken off, which is why it is not `净额` — see ruling 3. |
| `notLocationSpecific` | Not location-specific | 非门店专属 | The remainder row in the unfiltered expense breakdown: cost that belongs to the business rather than to any one place (§36, blank location). |
| `transactions` | Transactions | 交易记录 | The second Finance sub-view. NOT the top-up screen's `近期充值记录`, which is one channel's history, not the ledger. |
| `noCostRecorded` | This period has no recorded cost data. | 此期间未记录成本数据。 | The §1.12 seventh state, on the cost-of-goods and gross-profit lines. Past tense, agentless, no date — see ruling 4. |
| `excludedCosts` | Business-wide costs of {amount} are not included in this figure. | 不含全店成本 {amount}。 | Under a filtered Contribution figure, naming what it leaves out. |
| `summary` | Summary | 汇总 | The first Finance sub-view, named on the strip beside Transactions. |
| `moneyIn` | Money in | 进账 | The in direction — tile, chip and row group on Transactions. **`进账`, NOT `收入`** — see note 1. |
| `moneyOut` | Money out | 支出 | The out direction — tile, chip and row group. Deliberately the label already live for expenses — see note 2. |
| `directionIn` | In | 进 | The value in a row's Direction cell, where `moneyIn` is the group heading. |
| `directionOut` | Out | 出 | The value in a row's Direction cell, where `moneyOut` is the group heading. |
| `direction` | Direction | 方向 | The Transactions table's Direction column head. |
| `postedByPurchasing` | Posted by Purchasing | 采购单自动记入 | The mark on a PO-derived expense row: written by the poster, not typed, and not editable here (§36). |
| `openPurchaseOrder` | Open purchase order | 查看采购单 | The row action on a PO-derived row. **Purchase order, never bare "order"** — on a Finance screen that reads as a customer order (§36). |
| `categorySubtotals` | Sum of {n} category subtotals | {n} 个类别小计合计 | The quiet note on a PO row saying its figure is a sum. **Absent entirely at n = 1** — see note 3. Interpolated: see the glue rule below. |
| `nothingRecordedYet` | Nothing recorded yet | 暂无记录 | The §1.12 EMPTY heading on Transactions. |
| `transactionsEmpty` | Rent, wages and one-off costs you record will appear here — alongside anything Purchasing posts from a purchase order. | 您记录的租金、工资和一次性费用将显示在此处，以及采购单自动记入的支出。 | The §1.12 empty BODY, naming what will arrive. Names typed rows and PO postings, never orders — Transactions does not list orders (§36). |
| `noMatchingRecords` | No matching records. | 没有符合条件的记录。 | The §1.12 NO-RESULTS sentence. A different state and a different sentence from empty above; a filtering screen ships both. |
| `filterTransactions` | Filter these transactions | 筛选交易记录 | The search placeholder on the Transactions filter row. |
| `clear` | Clear | 清除 | The control that drops the filter, beside `noMatchingRecords`. **Reused, not minted** — recorded here so the pairing is explicit rather than inferred at each call site. |
| `newTransaction` | New transaction | 新建交易 | The CTA on Transactions and the heading of the form it opens. The one Dusk element on the page (§1.8). |
| `deleteTransaction` | Delete this transaction? | 删除这条交易记录？ | The confirm title before a typed row is deleted. The house pattern `确定删除该…？` is live but carries no noun for this. |
| `deleteTransactionBody` | This removes the row from the ledger. | 此操作将从账本中移除该记录。 | The confirm body's first sentence. Its second is the live `This cannot be undone. · 此操作无法撤销。`, reused rather than re-minted. |

**THE THREE WRITE-HALF PAIRS WERE ADDED 2026-09-02**, with the form that types a
row. Confirmed by Ash on the same terms as everything else in this table: **his
own words, not minted under the fourth amendment's delegation, so they carry no
"Ash should correct these" caveat.**

**Everything else the form says is REUSED, not minted**, and that is the reason
only three were needed. `routes/finance.js` already ships bilingual strings in
this exact domain — `date required · 日期必填`, `amount must be positive ·
金额必须大于零`, and both PO refusals — and the confirm body's second sentence,
`This cannot be undone. · 此操作无法撤销。`, is live at
`public/retail-admin/09-products.js:2013`. Save, Cancel, Delete, Date, Amount,
Category and Note are live across the admin. **A pair is minted here only where
no live source says the same thing about the same object.**

**THE THIRTEEN TRANSACTIONS PAIRS, AND `clear`, WERE ADDED 2026-09-02.** They
serve the Transactions screen, the second Finance sub-view, and were confirmed
by Ash on the same terms as the staircase pairs above: **his own words, not
minted under the fourth amendment's delegation, so they carry no "Ash should
correct these if they read wrong to a Chinese operator" caveat.** They are the
locked source everything else copies from. Three notes stand on them.

**1. `moneyIn` IS `进账`, NOT `收入`.** `收入` is reserved for **Income**, which is
a different thing in Tacet, and ruling 1 above already keeps it away from
Revenue for the same reason. **The two must never collapse.** A screen that used
`收入` for the in direction would name Income in the one place the distinction
has to survive — the Chinese view, which is the half most of these operators
read.

**2. `moneyOut` IS `支出`, WHICH IS ALREADY LIVE AS A GENERIC EXPENSES LABEL.**
**The reuse is deliberate rather than a collision overlooked:** on the
Transactions screen it means exactly that — money leaving the business — so a
second word for it would be the invention, not the reuse.

**3. `categorySubtotals` VANISHES ENTIRELY AT n = 1, per §36.** **The pair exists
for n greater than 1 only.** When nothing was collapsed, a note asserting a
breakdown sends the operator looking for one that does not exist, and §36 is
explicit that it must not read "1 category" either. Absence is the rendering at
one, not a shortened string.

**`categorySubtotals` IS INTERPOLATED AND MUST NOT BE GLUED**, on the same terms
as `excludedCosts` below: `{n}` is filled in at render and needs a
`data-lang-block` pair or a label-isolation span per §1.11. It is a count rather
than a money figure, so it does not carry `excludedCosts`'s currency caveat —
but the glue rule is the same one and is not relaxed by that.

**`excludedCosts` IS INTERPOLATED AND MUST NOT BE GLUED.** `{amount}` is filled
in at render. Per §1.11's interpolation rule it needs a `data-lang-block` pair or
a label-isolation span — a string built by concatenating a translated head to a
number is the failure that rule exists to prevent. Note that `{amount}` is not
the `%d` used by the receiving pairs above: `%d` marks an integer the screen
counts, `{amount}` a formatted money figure with its own currency symbol, which
is per business (§0) and never part of the string.

**`noCostRecorded` IS A SENTENCE, NOT A VALUE.** It does not replace a figure in
a cell. §1.12's treatment is show what IS known plus one past-tense sentence
saying why the rest is not — no dashed rows, no alarm colour, no icon, no retry.
The existing `not recorded` / `未记录` pair in
`public/retail-admin/08-customers.js` is a VALUE for one absent field and is a
different string doing a different job; neither replaces the other.

**NOTHING LIVE IS RETROFITTED BY THIS AMENDMENT.** The existing `营收` and `收入`
instances stay exactly as they are. Ruling 1 binds new work and settles what
Finance ships; bringing the four live variants onto one pair is a separate pass
against a separate diff, so that a vocabulary lock and a sweep of shipped
screens are never the same commit.

Sentence case, no exclamation marks. Both sentence strings keep their full stops
— `。` in CN, `.` in EN — because each is a whole remark about the figure above
it rather than a label on it.

## Channel money breakdown — the fees a platform charges (2026-09-02)

Rule 4 says never compose new Chinese and that additions require an amendment to
this document. This is the NINTH such amendment, and it is the first opened
under the *when no locked source exists* amendment recorded in
`docs/tacet-consolidation-decisions.md` (2 Sep 2026) — three of its five entries
are LIFTED FROM THE CHANNEL under that amendment's first preference, and two are
COMPOSED and marked PROVISIONAL under its third.

**The three lifted pairs are not minted and not translated.** They are the
wording Meituan and Eleme already show us on their own merchant screens, copied
verbatim, and the platform each came from is recorded beside it. A merchant
reading our breakdown beside the platform's own sees the same words for the same
money, which is the point: these name figures the operator will reconcile
against the platform, not figures we compute.

**The two provisional pairs are a debt, not a shortcut.** Neither names anything
a platform displays, so preference 1 could not reach them, and both were needed
before an operator was available to answer, so preference 2 could not either.
They ship marked, and they are reviewed by a native operator before the feature
they serve leaves beta. **A composed string that is not marked provisional is a
rule violation regardless of whether it turns out to be correct** — these are
marked.

| Key | EN | CN | Source | What it says |
|---|---|---|---|---|
| `customerDeliveryFee` | Customer delivery fee | 顾客配送费 | Meituan + Eleme merchant app | What the customer paid to have the order brought to them. The platform's own words on both channels. |
| `merchantDiscount` | Merchant discount | 商家对顾客的活动补贴 | Eleme merchant app | The shop's own promotion, funded by us rather than by the platform. Eleme's wording; Meituan shows no equivalent line. |
| `estimatedIncome` | Estimated income | 预计收入 | Meituan + Eleme merchant app | What the platform expects to settle to us. ESTIMATED on both channels' own screens, and the word is kept: it is not what landed. |
| `breakdownIncomplete` | Breakdown incomplete | 明细不完整 | **PROVISIONAL** — composed 2 Sep 2026, awaiting operator review | The state where a channel gave us some of the money lines and not all of them. Names no platform figure, so nothing could be lifted. |
| `settlement` | Settlement | 结算明细 | **PROVISIONAL** — composed 2 Sep 2026, awaiting operator review | The money a platform actually paid, as against what it estimated. No channel screen we hold uses one word for this. |

**WHY `预计收入` KEEPS ITS FIRST TWO CHARACTERS.** `预计` is the platform saying
*estimated*, and dropping it to read `收入` would both assert a figure that has
not settled and collide with Income, which Finance keeps for a different thing
(see the Finance section's ruling 1). The channel's own hedge is part of the
string, not decoration on it.

**NOTHING LIVE IS RETROFITTED BY THIS AMENDMENT.** These pairs bind new work.

## Unit cost sanity warning — the product editor (2026-09-02)

Rule 4 says never compose new Chinese and that additions require an amendment to
this document. This is the TENTH such amendment, and it is the first pair
**ADOPTED FROM LIVE CODE rather than minted or translated.** The pair was
already shipping at `public/retail-admin/09-products.js:1306`, as the trailing
clause on the product editor's margin line whenever cost exceeded price, before
either half of it existed in this document's locked tables. Locking it here
closes that gap rather than composing a second string for the same condition.

| Key | EN | CN | Source | What it says |
|---|---|---|---|---|
| `sellingBelowCost` | selling below cost | 低于成本销售 | Adopted from `public/retail-admin/09-products.js:1306`, live before this amendment. Confirmed by Ash, 2026-09-02. | A product's unit cost exceeds its sell price. Shown on the product editor's `.pd-cost-warn` pill the moment the cost is typed or the product is opened, and unchanged on the margin line's own Meituan-actual figure, which compares cost against a different revenue. |

**NOT A REFUSAL.** `docs/tacet-consolidation-decisions.md` §36, *Unit cost
exceeding sell price now warns*: the save proceeds regardless. This pair labels
the condition; it does not block anything.

**NOTHING LIVE IS RETROFITTED BY THIS AMENDMENT beyond the one site the pair was
already live on.** The Products list margin cell is not touched.

## Deferred — recorded, not in scope of this lock

- **Pickup slots whose hour exists only in the stored label** (`scheduled_for` is a day-only date, the time lives in `delivery_slot_label`): deriving the display from the order's own data would drop the hour, so those rows still render the customer's stored words and can show a checkout-language clock. The fix is to persist the pickup time as a real timestamp — a schema change, Orders stage.

These are structural findings from the survey, deferred to the Orders stage of the consolidation: the six overlapping status vocabularies; the three sweeps bypassing `STATUS_TRANSITIONS` and `rider_pickup`'s absence from it; dead/half-dead states (`placed`, `arrived_local`'s missing render branch); schema-comment drift (7 vs 9 statuses, 8 vs 9 codes, missing `supplier` mode); four statuses collapsing to one amber; hardcoded status hex colours vs `--td-*` tokens. This document locks WORDS; it does not redesign machinery.

## Stock movement — picking and receiving (LOCKED 2026-09-03)

Rule 4 says never compose new Chinese and that additions require an amendment to
this document. This is the ELEVENTH such amendment, opened and closed 2026-09-03.

Confirmed by Ash (operator), September 2026. Source of truth for all warehouse
picking and shop receiving screens. Do not compose alternatives; lift from here.

**These are Ash's own words, confirmed directly as the operator**, so they carry
no "Ash should correct these" caveat — they are not minted under the fourth
amendment's delegation and they are the locked source everything else copies
from.

**It is the first section about stock moving BETWEEN OUR OWN BUILDINGS.** Every
table above covers goods arriving from a supplier, an order leaving for a
customer, or money. These cover a warehouse picking a shop's request and that
shop counting what turned up — both ends of one internal movement, and neither
end has a supplier or a customer in it.

**Picking (warehouse)**

| English | 中文 |
|---|---|
| Pick list | 拣货单 |
| All shops | 全部门店 |
| Combined from N shop requests | 已合并 N 个门店的补货申请 |
| picked | 已拣 |
| lines picked | 项已拣 |
| Short (control) | 短少 |
| Scan | 扫码 |

**Receiving (shop)**

| English | 中文 |
|---|---|
| Receiving | 收货 |
| From the warehouse | 来自仓库 |
| Count (control) | 点数 |
| As sent | 与发货一致 |
| Short | 短少 |
| Over | 多收 |
| asked (quantity requested) | 申请 |
| Sent (quantity dispatched) | 发出 |
| counted (quantity actually received) | 实收 |
| Against what you asked for (heading) | 与申请对比 |
| lines counted | 项已点 |
| Confirm receipt | 确认收货 |

**Notes**

- 短少 is shared across both screens and means the same thing in each: fewer than
  expected.
- **短少 IS THE ONLY WORD FOR SHORT, PRODUCT-WIDE — RULED BY ASH, 2026-09-03.**
  `短缺` was previously used in purchasing (`public/retail-admin/16-purchasing.js`
  and `routes/purchases.js`) and **is retired as of this ruling**. The fourth
  amendment's per-product-lines note endorsed it and is marked historic above.
  Unlike every other "nothing live is retrofitted" note in this document, this
  ruling DOES sweep the shipped screens: two words for one condition on two
  screens about the same delivery is the defect the rule exists to prevent, and
  leaving them apart would have kept the collision alive under a lock that
  claims to have settled it.
- 多收 is its counterpart on the receiving side only. A picker cannot find more
  than was asked for; a shop can receive more than was sent.
- Shop names (天河店, 越秀店) are data, not vocabulary. They come from the
  locations table and are never hardcoded.
- Order references (RS-260902-004), SKUs, and unit suffixes (500g, 250ml) are
  exempt from the no-English-in-the-Chinese-view rule.
- **`申请`, `实收` and `与申请对比` WERE TRANSLATED WITH ASH'S EXPLICIT PERMISSION,
  2026-09-03**, and are locked like the rest of this section. They serve the
  `Received` screen's two-gap line, which states what the store asked for, what
  the warehouse sent, and what she counted. Four things about them:
  - `申请` matches the already-locked `补货申请`, so the same word carries all the
    way from the request through to the receipt. A second word for the requested
    quantity would break that thread at exactly the point the two figures are
    put beside each other.
  - `实收` is the standard logistics term for the quantity actually received, and
    shares `收` with the already-locked `多收`.
  - The three read together as **`申请 18 · 发出 14 · 实收 10`** — requested, sent,
    actually received. The gap between the first two is the warehouse's; the gap
    between the last two is the road's.
  - **`实收` IS THE OUTCOME QUANTITY AND MUST NOT COLLAPSE ONTO `点数` OR
    `项已点`.** `收` is the outcome, `点` is the act of counting: `点数` is the
    CONTROL that opens the keypad, `项已点` is the progress tally while she works,
    and `实收` is the number that lands on the shelf. A screen that used one for
    another would name an action where it means a quantity.

**THE RECEIVED SCREEN'S TWO-GAP LINE — THREE TERMS, TRANSLATED WITH ASH'S
EXPLICIT PERMISSION AND LOCKED 2026-09-03.** Added with the receiving artboards'
`Received` screen, which states both gaps on one line: what the store asked for,
what the warehouse sent, and what she counted. `发出` covers the middle figure and
was locked with the rest of the table above.

**AMENDED 2026-09-03 — THE PAIRS EXIST; THIS BLOCK IS NO LONGER A DEBT.** It
opened the same day as **PROVISIONAL**, with the Chinese halves deliberately left
empty rather than drafted, and it closed the same day: Ash authorised the
translation directly. **A composed string that is not marked provisional is a
rule violation regardless of whether it turns out to be correct** — these were
marked, and are now confirmed rather than quietly promoted.

| Key | EN | CN | Source | What it says |
|---|---|---|---|---|
| `askedQty` | asked | 申请 | Translated with Ash's explicit permission, 2026-09-03 | What this store requested, before the warehouse allocated anything. The gap between it and `发出` is the warehouse's, not the road's. `申请` matches the already-locked `补货申请`, so one word carries from the request through to the receipt. |
| `countedQty` | counted | 实收 | Translated with Ash's explicit permission, 2026-09-03 | What she counted off the van, standing alone on a line rather than as the `项已点` tally. The standard logistics term for the quantity actually received; shares `收` with `多收`. **Never `点数`, which is the CONTROL, and never `项已点`, which is the progress tally.** |
| `againstAsked` | Against what you asked for | 与申请对比 | Translated with Ash's explicit permission, 2026-09-03 | The section heading over those lines. It replaced *What differed*, which meant differed from what was SENT and therefore hid every line the warehouse cut before loading. |

**THE THREE READ TOGETHER AS `申请 18 · 发出 14 · 实收 10`** — requested, sent,
actually received — and that is the order they appear in on the line, because it
is the order the goods moved. `实收` is the outcome quantity: `收` is the outcome
and `点` is the act of counting, so a screen that reached for `点数` here would
name an action where it means a number.

**THE CHINESE `Received` ARTBOARD WAS BLOCKED ON THESE AND IS NOW DRAWN**
(`design-handoff/store-receiving/ReceivedZH.dc.html`). Nothing shipped
English-on-both-sides in the interval — the screen simply was not drawn in
Chinese until the pairs existed, which is the behaviour Rule 4 asks for rather
than a delay to apologise for.

**SEVEN MORE STRINGS THE CHINESE ARTBOARDS ALREADY NEEDED — COMPOSED, THEN
CONFIRMED. Locked 2026-09-03.** These are not operator-supplied and the
distinction is deliberate: every entry in the tables above came from Ash as the
operator or was translated on his explicit instruction, and **these were written
first and shown to him afterwards.** He has seen them and they stand, but a
reader must be able to tell the two provenances apart at a glance, so they sit
in their own table rather than being folded into the receiving one.

| Key | EN | CN | Where | What it says |
|---|---|---|---|---|
| `receivedTitle` | Received | 已收货 | `ReceivedZH` screen title | The delivery is closed and the stock has landed. Past tense, matching the English; **not `收货`**, which is the LIVE screen she counts on and is locked above. |
| `unitsAddedHere` | units added to this store | 件已入本店库存 | `ReceivedZH` summary card | Names the shelf the units joined, not the delivery. `本店` is the store reading the screen — never a store name, which is data. |
| `lineCount` | N lines | 共 N 项 | `ReceivedZH` and `MainZH` (receiving) | How many product lines the delivery has. **Distinct from `项已点`**, which counts how many she has finished; this one never moves. |
| `today` | today | 今天 | `ReceivedZH` timestamp | Relative day beside a clock time. |
| `backToStock` | Back to stock | 返回库存 | `ReceivedZH` closing control | Leaves the receipt for the store's own stock screen. |
| `allRecordedNothingNeeded` | All three are recorded against this delivery and the warehouse can see them. Nothing else is needed from you. | 三项均已记入本次收货，仓库可以看到。无需您再做任何操作。 | `ReceivedZH` closing sentence | **BOTH HALVES ALWAYS**, on the same terms as `undoBlocked` and `returnBlocked`: the discrepancies are recorded AND nothing further is asked of her. Dropping the first leaves her wondering whether anyone will see them; dropping the second reads as an open task. |

**`共 N 项` WAS ALREADY SHIPPING IN `MainZH` BEFORE `ReceivedZH` WAS DRAWN**, and
went unflagged then too. It is recorded here rather than in the receiving table
because its provenance is the same as the rest of this block — composed at draw
time, confirmed after the fact — and pretending otherwise to tidy the tables
would be the exact dishonesty this block exists to prevent.

**THE PROCESS POINT, WHICH MATTERS MORE THAN THESE SEVEN STRINGS.** Composing
Chinese for a screen that needs it is not the failure — Rule 4's own amendment
route exists for precisely that, and three of the preferences in
`docs/tacet-consolidation-decisions.md` (2 Sep 2026) describe how. **The failure
is composing it silently.** `ReceivedZH` was reported as blocked on three
strings and then built with nine, and the six extra reached the repository
without ever being named. **When a new screen needs Chinese beyond what is
locked, every new string is listed in the report at the time it is written** —
before it is committed, not after someone reads the diff. A string nobody
declared cannot be reviewed, cannot be marked provisional, and looks identical
to a locked one to every reader who comes after.

**THREE CHINESE SOURCE COMMENTS EXIST AND ARE NOT VOCABULARY**, recorded so the
next reader does not mistake them for strings that escaped a lock:
`warehouse-picking/MainZH.dc.html:82`, and `store-receiving/ReceivedZH.dc.html`
lines 76 and 95. They are reasoning notes to whoever builds the screen, they
render nothing, and they are exempt — but they were composed in the same pass
and are named here for the same reason the seven above are.
## What a material line's Arrived box does — receiving (LOCKED 2026-09-04)

Rule 4 says never compose new Chinese and that additions require an amendment to
this document. This is the TWELFTH such amendment, opened and closed 2026-09-04.

WHY THE STRING IS NEEDED. On the desktop purchase receiving screen (`receiveRow`,
`public/retail-admin/16-purchasing.js`), a MATERIAL line's Arrived box behaves
differently from a product line's, and nothing on the row said so. The count
typed there never reaches stock — `applyReceivedToStock()` skips any line
carrying an `ingredient_id` before it reaches a stock call
(`routes/retail-purchasing.js`) — but it is not ignored either: the expense
posting sums `COALESCE(qty_received, qty)` with no kind branch, so that box is
the ONLY way to record a short material delivery. A 20-unit line with 15
delivered posts 160.00 if the box is left blank and 120.00 if 15 is entered.

Meanwhile the row's In-stock cell shows an em dash for ever, because
`stock_applied_qty` is never written for a material line. The two together read
as "the number you typed did nothing", which is wrong in the direction that costs
money — and is how the box came to be proposed for deletion, tried and reverted
on 2026-08-27. The reason it must stay was written down in a code comment, where
nobody hovering over the row can see it. The pair is on BOTH cells, because
either one alone leaves the other still saying it.

TWO EXISTING PAIRS WERE CONSIDERED AND REJECTED, recorded so the search is not
repeated. `posts to Finance → Expenses by itself.` / `会自动记入财务 → 支出。` is
about the ORDER TOTAL at placing time — it says nothing about stock and nothing
about one line, and on a per-row tooltip it would read as a claim about the whole
order. `Nothing touches stock until the goods arrive and you tick them in.` /
`在到货并勾选收货之前,库存不会有任何变动。` is the opposite case: it promises a
stock movement later, which for a material line never comes.

TWO DISTINCTIONS THE CHINESE MUST PRESERVE, because losing either turns the
tooltip back into the confusion it exists to remove:

1. THE NUMBER COUNTS, it is not ignored. Copy reading "materials don't use this"
   would tell an operator to leave a short delivery unrecorded, which posts the
   full ordered quantity to Expenses.
2. IT COUNTS FOR MONEY, NOT STOCK. A word meaning "recorded" or "saved" without
   naming WHERE leaves the operator still hunting for the number in the stock
   column.

HOW THE CN HALF WAS ARRIVED AT. Under the delegation the fourth amendment records
("you decide the chinese"), and built the same way — from words already on this
very screen rather than composed fresh:

- `记入财务 → 支出` — from the order-total banner in this same file:
  `posts to Finance → Expenses by itself.` / `会自动记入财务 → 支出。`
- `库存不会有任何变动` — verbatim from the clause beside it:
  `Nothing touches stock until the goods arrive and you tick them in.` /
  `在到货并勾选收货之前,库存不会有任何变动。`
- `物料` — the row's own Material badge (`matBadge`).
- `计入` and `门店库存` — from the confirmed-counts line under the receive table.
- `数量` — the word the empty state already uses for a counted delivery.

**COMPOSED, AND DECLARED AS COMPOSED.** v1.17 settles that composing Chinese is
not the failure — Rule 4's amendment route exists for exactly that — but that
composing it SILENTLY is. This pair is written by Claude from the clauses above
and has not been read by Ash at the time of locking. **Ash should correct it if
it reads wrong to a Chinese operator; nothing else depends on the exact
phrasing.**

**THE PAIR — composed 2026-09-04 under the fourth amendment's delegation.**

| Key | EN | CN | What it says |
|---|---|---|---|
| `materialArrived` | This count goes to Finance → Expenses. Materials are not stocked here, so it never changes stock. | 此数量会记入财务 → 支出。物料不计入门店库存,库存不会有任何变动。 | Tooltip on a material line's Arrived input and on its In-stock cell, on the desktop purchase receiving screen. Both carry the same string because they are two halves of one wrong impression. |

**PRODUCT ROWS CARRY NONE OF IT.** Their Arrived box does move stock, so the
sentence would be false on them.

Sentence case, no exclamation marks. **Neither half may contain ` · `** — the
value is set through `T()`/`cuT()` so the attribute holds one language, and the
walker in `public/retail-admin/10-extras.js` splits `data-tt` on that separator,
so a middle dot inside either half would cut the sentence in two. The `→` is part
of both halves and is the same arrow the Finance banner above already uses.

**THE COMMA IS HALF-WIDTH, DELIBERATELY.** It matches the live banner string this
pair echoes (`在到货并勾选收货之前,库存不会有任何变动。`, same file), and the
locked pair must match the shipped string byte for byte or the two drift apart
while both look right. Do not normalise it to `，`.


## The delegation becomes standing — Rule 4 amended (2026-09-06)

**Ash, 2026-09-06: "i want to change the role that you dont decide which chinese words to use. i want you to be able to decide yourself."** This is the amendment that carries it, and it is the FIRST time a rule in this document changes rather than gaining a section. Rules 1, 2, 3, 5, 6 and 7 are unchanged.

**WHAT CHANGES.** Rule 4's default flips. It read: never compose, copy from these tables, and where nothing fits, stop and ask. It now reads: **whoever is building decides the Chinese**, drawing on the preferences below in order, and does not stop.

**WHAT DOES NOT CHANGE, and it is the half that makes the delegation safe rather than merely faster.** Every composed pair is still written into this document, in the same commit as the code that uses it, marked as composed and by whom. That is not a hedge against Ash's ruling — he changed **who decides**, not **whether it is written down** — and this document has already ruled on the distinction in its own words at v1.17: *"composing Chinese is not the failure — Rule 4's amendment route exists for exactly that — composing it SILENTLY is."* A declared string can be read, corrected and locked. An undeclared one is indistinguishable from a locked one to everyone who comes after, which is how a wrong character survives.

**THE PREFERENCES, unchanged in order from §30's 2026-09-02 amendment; only the last one's status moves.**

1. **Copy a live pair.** A string already shipping in this product for the same thing about the same object. Still first, and still the answer most of the time.
2. **Lift from the source.** A platform's own merchant-screen wording for its own vocabulary, recorded with the platform and the screen.
3. **Compose.** No longer a last resort with a review debt — it is now an ordinary outcome. It is still declared here, still attributed, and Ash still corrects anything that reads wrong.

**PROVISIONAL IS RETAINED, NARROWED TO WHAT IT WAS ACTUALLY FOR.** A pair is marked PROVISIONAL where the *concept* is unsettled — a name for a thing whose behaviour may still change — not merely because a machine rather than a person chose the characters. Everything composed under this delegation is attributed; only some of it is provisional.

**WHY THIS IS RECORDED RATHER THAN JUST DONE.** The rule being lifted is the one that stopped a garbled string reaching a customer, and it was lifted for a real cost: work stalled on labels, and a control shipping without its Chinese half is a worse screen than one with a correctable label on it. Both halves of that trade belong in the record, so that a later reader meeting a wrong character knows it was a decision and not an accident. **The failure mode this rule guarded is silent**: a wrong or nonsensical character looks correct to whoever composed it and wrong to every Chinese reader who sees it. That risk now sits with Ash to catch on review rather than with a blocked control.

### First exercise — the number a shop calls (§49)

| key | EN | CN | provenance |
|---|---|---|---|
| `shopOrderCode` | Pick-up number | 取餐号 | **COMPOSED** under this delegation, 2026-09-06 |

**Register: OPERATOR** (Rule 1) — it labels the chip on the orders list and in the order drawer. §49's number itself is a numeral and needs no word beside it; what needed a label was the *chip*, so a new operator meeting an unexplained "7" beside an order number knows what it is.

**HOW IT WAS ARRIVED AT.** `取餐号` is the standard term on the screens and slips of Chinese counter-service food and drink shops — the number called when an order is ready to collect — which is exactly this. Two live candidates were considered and rejected, and are recorded so the search is not repeated: **`序号`** is live (`public/retail-admin/23-sku.js`) but means a sequence counter in a SKU rule and carries none of the counter's meaning; **`取餐`** is live in `lib/tracking.js`'s courier-stage matching as a rider's pickup verb, and the noun form here is a different part of speech about a different actor, so the two do not collide. **Ash should correct this if it reads wrong to a Chinese operator; nothing depends on the exact phrasing.**

**THE PRINTED SLIP IS DELIBERATELY NOT GIVEN THIS LABEL.** `lib/feie.js` prints the number and the name double-width with no word in front of either, because on 58mm paper a label costs the space that makes the number readable across a room, and the slip's reader is standing at a counter where nothing else is a bare numeral. The chip on a dense admin table is the opposite case. That is Rule 1's two registers doing their job, not an inconsistency.
## The counter basket — the QR menu (2026-09-06)

The cart on `/s/:shopCode` (§44, step 5b part 4). **Almost all of it is COPIED, not composed**, and that is deliberate rather than lucky: the customer who buys from the web store and the customer standing at the counter are the same person, and meeting two different words for *add* would make the shop feel like two shops. Register: CUSTOMER (Rule 1).

| key | EN | CN | provenance |
|---|---|---|---|
| `basket` | YOUR BASKET | 购物车 | LIVE — `public/shop.html` cart kicker |
| `subtotalLine` | Total | 合计 | LIVE — `public/shop.html` cart total |
| `placeOrder` | Place order → | 提交订单 → | LIVE — `public/shop.html` checkout button |
| `name` | Name | 姓名 | LIVE — `public/app.html`, and the admin |
| `cancel` | Cancel | 取消 | LIVE — `public/shop.html` |
| `soldOut` | Sold out | 售罄 | LIVE — already on this page since step 5a |
| `orderPlaced` | Order placed! | 下单成功！ | LIVE — `public/shop.html` order-success |
| `orderNoLabel` | Order | 订单号 | LIVE — `public/shop.html` order-success |
| `payAtCounter` | Pay at the counter. | 请到收银台付款。 | **COMPOSED** under Rule 4's standing delegation |
| `tryAgain` | Please try again. | 请重试。 | **COMPOSED** under Rule 4's standing delegation |

**`payAtCounter` had no live source and could not have one.** It is the one sentence in this product about a customer walking to a till, because no other surface in Tacet has ever had a counter to walk to: the web store and the mini app both take money at checkout, and the till is operated by staff rather than read by a customer. `收银台` is the ordinary Chinese word for the counter where you pay in a shop.

**`tryAgain` is a generic retry** and was composed rather than lifted because the live storefront's failure copy is all specific to a cause (a payment rail, an address, a voucher) and none of it fits "the network dropped". Kept deliberately short and blameless: the customer is standing in a queue and the useful information is *tap it again*, not what went wrong.

**Ash should correct either if it reads wrong to a Chinese operator; nothing depends on the exact phrasing.**

**WHAT CARRIES NO STRING AT ALL, and it is the larger half of this section.** The add control is `+`, the quantity controls are `−` and `+`, the close control is `×`, and the placed order shows a numeral and a name with no label over either. Every one of those was a candidate for a label and every one reads better without: a numeral in double-width beside a customer's own name needs no word, and on a phone in a queue a word is a thing to read rather than a thing to act on. Rule 4 is not the only reason to mint fewer strings.

## Paying on the QR menu — in-page WeChat (2026-09-06)

The payment choice in the basket and the payment page behind it (`docs/tacet-consolidation-decisions.md` §50). **Three entries, of which two are COPIED and one is cut down from a string this document already locks.** Nothing here is minted from nothing, and the section is short because §50's design deliberately reuses the screens that already existed: the payment page is the placed-order screen with a different sentence on it. Register: CUSTOMER (Rule 1).

| key | EN | CN | provenance |
|---|---|---|---|
| `payWechat` | WeChat Pay | 微信支付 | LIVE — `public/shop.html`'s own checkout row, verbatim |
| `payCounterBtn` | Pay at the counter | 收银台付款 | **COMPOSED** by cutting down the locked `payAtCounter`, 2026-09-06 |
| `paymentReceived` | Payment received! | 支付成功！ | LIVE — `public/shop.html`'s payment-success screen, verbatim |

**`payWechat` is WeChat's own name for itself and there was never a decision to make.** It is taken from the storefront's checkout row rather than from WeChat's documentation so that the string in this product has one source; the two agree, which is the point.

**`payCounterBtn` is `payAtCounter` with the request and the full stop removed, and that is the whole of the composition.** The locked sentence `请到收银台付款。` is an instruction given to somebody whose order is already placed — *please go and pay at the counter*. Beside it in the basket sits a button offering a choice not yet made, where a polite imperative and a full stop both read wrong: a button is a label, not a sentence. `收银台付款` keeps every character that carries meaning and drops the two that turn it into an instruction. **The alternative considered and rejected was reusing the locked sentence unchanged on the button**, which would have needed no entry here at all — rejected because a full stop inside a button is the kind of small wrongness that makes a screen feel machine-made, and because the two strings then could not be told apart in a search when one of them needs to change.

**No string was minted for the failure cases, and that is deliberate.** Everything that can go wrong on the payment page — no Official Account, a refused code, a cancelled payment, a customer who arrived from a camera app rather than WeChat's scanner — renders the placed-order screen the customer would have seen anyway, carrying the already-locked `orderPlaced` and `payAtCounter`. §50 rules that all of them end at the till, so all of them say the one thing that is true and useful there. A bespoke sentence per failure would be four more strings telling a customer in a queue something they cannot act on.

**Ash should correct `收银台付款` if it reads wrong to a Chinese operator; nothing depends on the exact phrasing.**

## Quick stock — the count keypad and the drop fork (2026-09-06)

`public/stock.html` (`tBlocked()`) and `public/m.html` (`TB()`) are the two Quick
stock surfaces `docs/tacet-quick-stock-addendum.md` describes as kept 1:1 on
tokens and components; both were shipping the SAME nine-to-fifteen strings
English-on-both-sides, reported by a shop operator reading `杏仁酱` on an
otherwise-Chinese screen. Register: staff-facing shop-floor/kitchen tool —
outside the order-status registers Rule 1 names, but the same "one English
string, one Chinese string" discipline applies. Composed and copied under
Rule 4's standing delegation; nothing here has been shown to Ash yet, so
every row carries the "Ash should correct this if it reads wrong" caveat.

| EN | CN | provenance | where |
|---|---|---|---|
| On the shelf | 在架 | **COPIED** — `public/m.html`'s own product-row meta already ships this exact "label + shelf figure" construct (`on shelf ` / `在架 `) | both |
| Added today | 今天已加 | **COMPOSED** — reuses 加 from this same page's `加库存` (title), `加入库存` (Add to stock) and `已加 N 件` (Added toast) | both |
| Correct the count | 校正数量 | **COMPOSED** — reuses 校正 from the live ledger reason `Correction · 校正` (`public/app.html`) and 数量 from this page's own `Set count · 设置数量` | both |
| How many are on the shelf? | 在架有多少? | **COMPOSED** — parallel to this page's own live `How many did you make? · 制作了多少?` | both |
| Count on the shelf | 在架数量 | **COMPOSED** — reuses 在架; a field label distinct from the title above it | m.html only |
| Save the count | 保存数量 | **COMPOSED** — reuses 保存 (live `Save · 保存`) and 数量 | stock.html only (m.html's correcting keypad reuses the shared `Add to stock`/`Save` control) |
| Shelf says {a}, you counted {b}. | 在架 {a}，你数的是 {b}。 | **COMPOSED** — reuses the 在架-plus-figure construct above | both |
| I counted wrong — save {n} | 数错了——保存 {n} | **COMPOSED** | both |
| Something is missing or spoiled | 少了或坏了 | **COMPOSED — deliberately generic.** Does NOT borrow a reason word from `WASTE_REASONS` in `public/app.html` (`变质` spoiled, `损坏` damaged, …): the comment beside this button in both files says it is deliberately not a reason picker (§46), so its Chinese must stay as unspecific as its English | both |
| The count stays as it is. Tell whoever records waste — they enter what was lost, and the count follows from that. | 数量保持不变。请告诉负责记录损耗的人——他们录入损失后，数量会随之更新。 | **COMPOSED** — reuses 记录损耗 from the live `Record waste · 记录损耗` control (`public/m.html` waste screen) | stock.html (fork note) |
| The count stays as it is. Tell whoever records waste. | 数量保持不变。请告诉负责记录损耗的人。 | **COMPOSED** — m.html's own shorter toast form of the row above; same meaning, same 记录损耗 | m.html only |
| Count set to {n} | 已设为 {n} | **COMPOSED** — parallel to this page's own live `Added {n} · 已加 {n} 件` toast | both |
| The count has gone down | 数量变少了 | **COMPOSED** — m.html's generic ask-dialog needs a title; stock.html's fork sheet has no title element for this state | m.html only |
| Enter the number of units on the shelf — a whole number, 0 or more. | 请输入在架数量——整数，0 或以上。 | **COMPOSED** — validation message on m.html's free-text field; stock.html's keypad accepts only digits and needs no such message | m.html only |
| Set the count | 设置数量 | **COPIED** — this is an aria-label on the count button, and reuses this page's own live `Set count · 设置数量` verbatim rather than mint a synonym | m.html only |

`tBlocked()` / `TB()` are left defined in both files: they are the documented
escape hatch for the next string that has nothing to copy from and no time to
wait on, per this rule's own process point. Nothing currently calls either.

## The About page editor (2026-09-06)

The desktop editor at retail-admin → About page, opened by audit D-04. Register:
OPERATOR (Rule 1) — every string here is read by a merchant editing their own
shop, never by a customer.

**THE SECTION EXISTS BECAUSE THE EDITOR STOPPED SUPPLYING ITS OWN CHINESE.**
Until this commit the form arrived pre-filled with the first tenant's About
page — the manifesto, the founder's quote, the in/out list, all of it bilingual
— and a merchant who pressed Save wrote that copy into their own shop. Removing
it emptied the form, and an empty form needs two controls it never needed while
it came full: a way to add a stat row, and a note saying what an empty strip
does. Those two are the whole of what is minted here. Everything else the
screen says was already live and is listed below as copied, because the useful
fact about a nine-string change is that seven of the strings are not new.

| key | EN | CN | provenance |
|---|---|---|---|
| `chooseImage` | Choose image… | 选择图片… | LIVE — this editor's founder-photo control |
| `remove` | Remove | 移除 | LIVE — this editor's founder-photo control |
| `noImage` | No image | 暂无图片 | LIVE — `05-marketing.js`, `09-products.js` |
| `image` | Image | 图片 | LIVE — this editor's own upload messages |
| `loadFailed` | Could not load — reload the page | 加载失败 — 请刷新页面 | LIFTED whole from `public/app.html`'s "成本公式加载失败 — reload the page · 请刷新页面", fragments and separator unchanged |
| `addStat` | + Add stat | 添加数据项 | **COMPOSED** under Rule 4's standing delegation |
| `statStripEmpty` | (help) The strip is hidden while empty | 留空则隐藏数据条。 | **COMPOSED** under Rule 4's standing delegation |

**`addStat` — the live candidate was rejected on shape, and it is worth
recording which.** Its two siblings in this same block are `+ Add IN item ·
添加「是」项` and `+ Add OUT item · 添加「否」项`, and the obvious move was to
follow them literally into `添加数据条项`. That reads badly: `数据条` is the
strip, so the literal form says *add a stat-STRIP item* and stacks three nouns
to do it. The bracket in the live pair carries a one-character value — 是, 否 —
and there is no such value for a stat. `添加数据项` keeps the live verb and the
live `项`, drops the borrowed bracket, and says *add a data item*, which is what
the button does. An earlier draft of this branch shipped `添加数据条项`; it is
recorded here rather than quietly replaced, because the rejected form is the
more useful half of the note.

**`statStripEmpty` is the live pattern with one noun swapped.** This block
already carries `Leave blank to hide the Chinese paragraph. · 留空则隐藏中文
段落。`, so `留空则隐藏数据条。` is that sentence about this control, full stop
included. It is marked composed rather than copied because the noun moved, and
a swapped noun is a new string however small the edit.

**Ash should correct either if it reads wrong; nothing depends on the exact
phrasing and both sit on controls whose meaning is clear without them.**

**WHAT DELIBERATELY CARRIES NO NEW STRING.** The hero image's help text is
English only, matching the founder photo's help text six lines below it, which
has always been English only — one bilingual help line beside one English one
would read as an oversight in whichever language it was missing. The four
placeholders removed by this change (`We exist to make…`, `我们存在的意义…`,
`From soil to soul.`, `从土壤到灵魂`) are NOT replaced by composed neutral
equivalents: each field already carries a label naming it, and a placeholder
that has to be invented for a field the label already names is a string minted
to fill a gap that was not there. Rule 4's delegation is permission to compose
where a string is needed, not a reason to need one.

## The kitchen's printed request slip (2026-09-06)

The slip that prints in the kitchen when a job reaches its production queue, its
reprint control on `public/stock.html`, and the printer's settings block in
retail-admin. Serves `docs/tacet-consolidation-decisions.md` §51. Register:
OPERATOR (Rule 1) throughout — a customer never sees any of it.

**THE USEFUL FACT ABOUT THIS CHANGE IS HOW LITTLE OF IT IS NEW.** The product
has been announcing kitchen requests for months and printing receipts for
longer, so almost every word this feature needs was already somewhere in the
tree with an English partner: the push that announces a request supplied the
slip's two headers, the kitchen's own request screen supplied its body, and the
PHONE'S REPRINT CONTROL — which has said all of this for a receipt since long
before the kitchen had a printer — supplied every string on the new button.
Six pairs are composed, all of them in the settings block, and the reason they
are the only ones is that a settings block is the one part of this feature the
product had never had to describe.

| key | EN | CN | provenance |
|---|---|---|---|
| slip header, arrival | New kitchen request | 厨房新请求 | LIVE — `routes/restock.js`, the push this slip is the paper twin of |
| slip header, completion | (order) is made | 制作完成 | LIVE — same push, the `prepared` title |
| slip purpose | For an order | 用于发货 | LIVE — `public/kitchen.html`, `public/stock.html` request views |
| slip purpose | For the shelf | 货架补货 | LIVE — same two views |
| slip section | Items | 物料 | LIVE — `public/kitchen.html` request detail |
| slip section | Note | 备注 | LIVE — same screen |
| slip origin fallback | From warehouse | 来自仓库 | LIVE — `public/kitchen.html` request card |
| reprint, idle | Print the slip again | 重新打印 | LIFTED from `public/retail-admin/04-orders.js`'s live `…检查组件和打印机后重新打印`; the CN drops the noun the screen already supplies |
| reprint, busy | Printing… | 打印中… | LIVE PAIR — `public/m.html`'s reprint button, verbatim |
| reprint, after a failure | Did not print — print it again | 打印失败 — 重新打印 | LIFTED — `小票打印失败` (`public/m.html`) with its receipt noun dropped, joined to the row above |
| reprint failed | The printer did not take it. Check that it is on and has paper. | 打印机没有接收。请检查是否开机、有纸。 | LIVE PAIR — `public/m.html`, verbatim, both halves |
| refusal on a transfer | This is a transfer between locations, not a kitchen request | 这是门店之间的调拨,不是厨房制作请求。 | LIVE — `routes/restock.js` `kitchenScopedOrder`, verbatim |
| settings, SN | Printer SN | 编号 | LIVE — the by-store printer block directly above it |
| settings, copies | Copies | 份数 | LIVE — same block |
| settings, heading | Kitchen printer | 厨房打印机 | **COMPOSED** under Rule 4's standing delegation |
| settings, label | When it prints | 何时打印 | **COMPOSED** under Rule 4's standing delegation |
| settings, option | When a request arrives | 请求到达时 | **COMPOSED** under Rule 4's standing delegation |
| settings, option | When the kitchen marks it made | 制作完成时 | **COMPOSED** — the live `制作完成` above, plus 时 |
| settings, option | Both | 两者都打印 | **COMPOSED** under Rule 4's standing delegation |
| settings, option | Never — notification only | 不打印,仅通知 | **COMPOSED** under Rule 4's standing delegation |
| settings, help | The kitchen prints its own request slip when a job lands in the production queue… | 制作请求进入队列时,厨房自动打印制作单;没有打印机则留空。 | **COMPOSED** under Rule 4's standing delegation |

**THE SLIP IS NOT A 小票, AND THAT IS THE ONE PLACE A LIVE PAIR WAS REJECTED.**
`public/m.html` carries `Reprint receipt · 重打小票`, which is the closest live
string to the new button and was the obvious copy. It is not taken, because
`小票` is a receipt — a priced document handed to a customer — and this slip is
a production ticket with no money on it anywhere. Copying the pair would have
put the wrong noun on the button in the half of the product that reads Chinese
and been invisible in the half that does not. **The verb is still lifted rather
than minted**: `重新打印` is live in `04-orders.js`'s label-printing failures,
and the CN drops the noun because the button sits inside the request's own
screen, which supplies it. Restructuring a label so a live string fits it beats
composing a new one — `CLAUDE.md`'s practical note, applied.

**The six composed pairs are all in the settings block, and none of them names
anything new.** `厨房` and `打印机` are both live in this same admin screen
(`各门店打印机` sits four lines above the new heading); `制作完成时` is the
live `制作完成` with the time particle; `请求`, `打印` and `通知` are each live
in this tree. What had no source is the SHAPE of a when-does-it-print chooser,
because no other printer in the product has one — the store printers print when
an order is paid and there was never a second moment to choose between.

**Ash should correct any of the six if they read wrong.** Nothing depends on
their exact phrasing: each sits on a labelled control in a settings panel whose
meaning is carried by its English half and by the control itself.

**WHAT DELIBERATELY CARRIES NO STRING.** The slip prints no label in front of
the request number or the item quantities — a numeral in double-width at the top
of a ticket needs no word before it, the same reasoning §49's counter number
records in `lib/feie.js`. The reprint control renders nothing at all on a request
that was never owed a slip, rather than a disabled button with an explanation:
a kitchen with no printer configured is not a failure state to describe.

## The two doors into a shop — the till and the QR menu (2026-09-07)

The refusals `POST /api/retail-admin/orders` returns when a shop order does not
name the door it came through, or when an order on another channel claims one
(`docs/tacet-consolidation-decisions.md` §44, amended 2026-09-07). **Two
entries, BOTH COMPOSED**, and the section exists to say why nothing could be
copied. Register: ADMIN (Rule 1) — these render in the New order form's `route`
block, beside the channel control.

| key | EN | CN | provenance |
|---|---|---|---|
| `shopEntryRequired` | A shop order must say which way it came in — the till or the QR menu. | 门店订单需注明来自前台还是二维码。 | **COMPOSED** under Rule 4's standing delegation, by Claude, 2026-09-07 |
| `shopEntryNotAllowed` | Only a shop order comes in through the till or the QR menu. | 只有门店订单才能标注前台或二维码来源。 | **COMPOSED** under Rule 4's standing delegation, by Claude, 2026-09-07 |

**Neither had a live source, and the reason is structural rather than an
oversight.** No screen in this product has ever had two doors into one shop to
tell apart: the web store and the mini app each have exactly one way in, the
till was the only way into a counter until §44's QR menu, and `source` — the
column that used to answer *how did this row get here* — answers a different
question and is why §44's amendment had to name a second column at all. A
sentence about choosing between two doors could not be lifted from a product
that had never had two.

**Every TERM in both sentences is live; only the sentences are composed, and
that distinction is the whole of what was minted here.** `门店` is the shop
channel's own label (`ordChannelLabel`, `public/retail-admin/04-orders.js`).
`前台` is the counter, taken from `前台销售` in the very map these two sentences
join — the `store_required_for_counter` refusal, already locked. `二维码` is the
ordinary live word for a QR code and appears across the admin's share-card and
payment-code panels. Nothing was invented at the word level.

**Two live candidates were considered and REJECTED, and both rejections matter
for the next reader.** `Shop menu · 门店商品` (`01-core.js`, `28-shops.js`) is
the closest live pair to "the QR menu" and is **not** taken: it names the
ADMIN's shop-listings editor — the screen where staff set prices — and reusing
it for the customer's QR page would make one string mean two screens, which is
the collision §3.1 of the IA blueprint renamed a whole rail folder to avoid.
`请选择订单来源。` (`channel_required`, live in this same map) is the nearest
live SENTENCE and is also not taken: it asks for the order's origin, meaning
how the customer reached the business, and §44 is explicit that a shop's door is
not an origin — the customer is at the shop, and conflating the two is the
confusion the amendment was written to end.

**THREE server codes share these TWO sentences, and that is house precedent
rather than economy.** `bad_shop_entry_method` and `shop_entry_method_required`
both carry `shopEntryRequired`, exactly as `bad_fulfillment_type` and
`fulfillment_type_required` share one sentence three rows below them in the same
map: a malformed value and a missing one ask the operator for the same thing, so
telling them apart on screen would be a distinction with no action behind it.
`shop_entry_method_not_allowed` is the opposite instruction and gets its own.

**NEITHER SENTENCE IS REACHABLE FROM THE NEW ORDER FORM, and they are locked
anyway.** That form never offers the `shop` channel and never sends a
`shop_entry_method`, so no operator can produce either refusal from it today;
the till, which does send both fields, always sends them as a matching pair. They
exist because the endpoint is reachable by other callers and because a server
error with no home on the page is precisely what `verify-fulfilment-types.js`
fails the build over. **The cost is named rather than hidden: two composed pairs
bought for a state nobody can currently reach.** The alternative — leaving the
codes unmapped — trades two strings for a generic failure beside a field that
may not be the wrong one, which that suite exists to prevent.

**Ash should correct either if it reads wrong to a Chinese operator; nothing
depends on the exact phrasing.**

## Typing a batch into Add stock (2026-09-07)

`public/m.html`'s Add stock card. Register: staff-facing kitchen tool, the same
one the *Quick stock — the count keypad and the drop fork* section above covers,
and this is that section's missing half rather than a new surface.

**THE SECTION LOCKS ONE STRING, AND THE USEFUL FACT IS THAT IT IS ONE.** The
card's count opened a type-in dialog in recount mode and was a plain `<span>` in
add mode, so a kitchen logging 130 bowls of soup had no way to enter 130 except
to tap `+` a hundred and thirty times. The fix gives add mode the door recount
already had — and `public/stock.html`, the sibling this file is kept 1:1 with,
has opened its own keypad from the count in BOTH modes since that screen existed.
So the question, the confirm verb and the field label were all already written:
`How many did you make? · 制作了多少?` and `Add to stock · 加入库存` are
`public/stock.html`'s own add keypad, quoted in the section above as the live
pair its `在架有多少?` was built parallel to, and `Quantity · 数量` is live in
this same file. They are **COPIED**, and are listed below only so the next reader
does not go looking for their provenance.

| EN | CN | provenance | where |
|---|---|---|---|
| How many did you make? | 制作了多少? | **COPIED** — `public/stock.html`'s add keypad label, verbatim; also the new button's aria-label | m.html (now both files) |
| Add to stock | 加入库存 | **COPIED** — `public/stock.html`'s add keypad save verb, verbatim | m.html (now both files) |
| Quantity | 数量 | **COPIED** — live in `public/m.html` already | m.html only |
| Enter how many you made — a whole number, 0 or more. | 请输入制作数量——整数，0 或以上。 | **COMPOSED** — see the note below | m.html only |

**THE ONE COMPOSED PAIR IS THE LIVE SENTENCE WITH ITS NOUN SWAPPED, on the same
terms as `statStripEmpty` in *The About page editor* above.** The section above
locks `Enter the number of units on the shelf — a whole number, 0 or more. ·
请输入在架数量——整数，0 或以上。` for the validation on the correction dialog's
field — the same generic ask-sheet field, one control away. Its structure, its
em-dash break and its whole tail `——整数，0 或以上。` are kept unchanged, and
only `在架数量` becomes `制作数量`, where `制作` is this page's own live
`制作了多少?`. It is marked composed rather than copied because the noun moved.

**Two live candidates were REJECTED and both rejections are recorded so the
search is not repeated.** `Enter what arrived — a whole number, 0 or more. ·
请输入到货数量 — 0 或以上的整数。` is the closest live sentence by shape and is
not taken: `到货` is goods ARRIVING FROM A SUPPLIER, and a kitchen that cooked
the soup received nothing — reusing it would put receiving's vocabulary on a
production write, which is the same class of collapse §46 exists to prevent
between a batch and a recount. `Enter a whole number for each store, 0 or more. ·
每家门店请输入 0 或以上的整数。` is rejected because its qualifier names a
per-store grid and this field is one product on one shelf; stripped of the
qualifier it would no longer be the live string.

**No string was minted for the affordance, and that is deliberate.** The count
also gained a visible edge, because a control nobody can tell from a label is a
control nobody taps — but a numeral needs no label, per Rule 4's own note, so
the border does the telling and the card gains no words.

**Ash should correct the composed pair if it reads wrong to a Chinese operator;
nothing depends on the exact phrasing.**

**AMENDED 2026-09-07 (v1.27) — the control moved, and the strings moved with it.**
`docs/tacet-consolidation-decisions.md` §60 replaces the sheet this section
locked with the count cell ITSELF as the field, because the sheet cost a second
tap to reach its own input. **No string is minted by that change and none is
re-translated** — they change which element carries them:

| EN · CN | was | is now |
|---|---|---|
| How many did you make? · 制作了多少? | the sheet's title | the field's `aria-label` |
| Add to stock · 加入库存 | the sheet's confirm button | the card's commit button |
| Enter how many you made — a whole number, 0 or more. · 请输入制作数量——整数，0 或以上。 | the sheet's validation line | the card's validation line, unchanged |
| Quantity · 数量 | the sheet's field label | **RETIRED on this screen** |

**`Quantity · 数量` is recorded as retired rather than struck out**, on this
document's own habit of leaving a superseded note in place: it is still live
elsewhere in `public/m.html`, and the reason it is gone from here is worth
keeping — a field with the count already in it, on a card naming the product,
has nothing left for a label above it to say. Nothing else in the table above
changes.


## A batch that could not be matched to a shelf (2026-09-07)

`public/m.html` and `public/stock.html`, the "What you made" screen both apps
reach from the kitchen queue. Register: staff-facing kitchen tool, the same one
*Quick stock — the count keypad and the drop fork* and *Typing a batch into Add
stock* above cover.

**THE SECTION EXISTS BECAUSE THE SCREEN GAINED TWO STATES IT HAD NEVER HAD.**
`docs/tacet-consolidation-decisions.md` §59, amended a second time on 2026-09-07,
stops the handover refusing when the shelf list has not arrived yet and when not
one line can be matched to it. Until then both were silence: the request closed,
nothing opened, and the operator was left on an empty queue with no record of
what they had made. A screen that now OPENS in those two states has to say
something in them, and that is all the new words are for.

**FOUR OF THE SIX ARE LIVE IN THESE SAME TWO FILES.** `加载中…` is the loading
line every list in both apps already uses; `货架加载失败。` is `loadQsItems`'s own
failure copy in `public/m.html`; `重试` is live across both; `登记批次` is the Log
a batch row's own name, and it is named here because it is the way forward when
this screen cannot be used.

| EN | CN | provenance | where |
|---|---|---|---|
| Loading… | 加载中… | **COPIED** — live in both files | m.html, stock.html |
| The shelf didn't load. | 货架加载失败。 | **COPIED** — `loadQsItems`'s own failure copy, verbatim | m.html, stock.html |
| Try again | 重试 | **COPIED** — live in both files | m.html, stock.html |
| Log a batch | 登记批次 | **COPIED** — the row's own name, quoted so the operator can find it | m.html, stock.html |
| The request is closed, but nothing has been added to stock yet. Try again, or record the batch from Log a batch. | 该申请已关闭，但库存尚未登记。请重试，或从「登记批次」记录本批次。 | **COMPOSED** — see below | m.html |
| The shelf didn't load. The request is closed, but nothing has been added to stock yet — try again, or record the batch from Log a batch. | 货架加载失败。该申请已关闭，但库存尚未登记 — 请重试，或从「登记批次」记录本批次。 | **COMPOSED** — see below | stock.html |

**WHAT IS ACTUALLY COMPOSED IS ONE CLAUSE, and the two sentences it sits in.**
`该申请已关闭` is lifted from the same screen's own success state
(`共 N 种商品。该申请已关闭。`), and every other term in both sentences is in the
table above. The new clause is `但库存尚未登记` — *but nothing has been added to
stock yet* — and **no live pair says it**, because no screen in this product has
ever had to tell somebody that a step they just completed left the stock
untouched. That sentence is the whole of §39 and §59 in one line, and it had
never needed saying until the screen could open without being able to act.

**ONE LIVE PAIR IS REJECTED and the rejection is recorded so the search is not
repeated.** `Stock pending · 库存待扣` — §58's operator note, locked for an order
whose fresh line has not been decremented yet — is the closest live string about
stock that has not moved, and it is not taken: `待扣` is stock waiting to be
DEDUCTED as goods leave, and this is the opposite direction, units that were MADE
and have not been added. Reusing it would put the deduction vocabulary on a
production write, which is the same class of collapse §46 exists to prevent
between a batch and a recount.

**`货架加载失败。` ALONE WAS CONSIDERED AS THE WHOLE MESSAGE and is kept as the
opening clause instead.** It names what failed and not the two facts the operator
has to act on — the request is already closed, and there is no way back to it, so
the only remaining route to recording the batch is the Log a batch door. A
failure on this screen cannot be a dead end, because the thing it failed at has
already happened.

**THE TWO SENTENCES DIFFER ONLY IN THAT `public/stock.html`'s CARRIES THE
FAILURE CLAUSE INSIDE IT**, that app rendering the whole state as one note rather
than as a heading and a body. The wording is otherwise identical, deliberately,
so the two siblings do not drift.

**Ash should correct either composed pair if it reads wrong to a Chinese
operator; nothing depends on the exact phrasing.**


**EXTENDED 2026-09-07 (v1.29) — the refusals that used to say nothing.** §59's
third amendment makes every path out of the kitchen queue that does NOT reach
this screen name itself, on the queue it drops back to. Four pairs, all
composed, and the lead clause is the one locked above rather than a second copy.

| EN | CN | provenance | where |
|---|---|---|---|
| Marked made — but the stock has not been recorded. | 已标记完成 — 但库存尚未登记。 | **COMPOSED** — assembled from `已标记完成`, live in both files, and `但库存尚未登记`, locked in the table above | m.html |
| This account cannot record a batch. Ask an admin for "Record what was made". | 此账号无法登记批次。请向管理员申请「登记生产批次」权限。 | **COMPOSED** — `此账号无法…` is the live refusal pattern in both files; `登记生产批次` is quoted verbatim from `production:log`'s label in `lib/capabilities.js` | m.html |
| There is no store on this account to add it to. | 此账号没有可入库的门店。 | **COMPOSED** | m.html |
| This request asked for no quantities, so there is nothing to add. | 该申请没有数量，无需入库。 | **COMPOSED** | m.html |

**QUOTING `登记生产批次` IS THE POINT OF THAT STRING, not a shortcut.** It is
what an admin reads on the permissions screen. A refusal that named the same
capability in different words would send two people hunting for two things — the
operator asking for something the admin cannot find, and the admin granting
something the operator did not mean.

**ONE GENERIC SENTENCE FOR ALL THREE WAS CONSIDERED AND REJECTED.** It would have
needed no new Chinese beyond the lead clause, which is the only argument for it.
The three refusals are acted on by three different people — an admin grants the
permission, an owner adds the store, the person who raised the request fixes its
quantities — so a sentence that covered all three would tell none of them what to
do, and the whole reason these strings exist is that silence told them nothing.

**Ash should correct any of the four if they read wrong to a Chinese operator.**

## Affiliate reward notification — the mini app inbox (2026-09-07)

The referrer's in-app notification (`retail_notifications`, category `affiliate`) fires automatically from `creditReferralReward()` the instant a friend's first paid order credits the referrer's wallet — the event behind the retail-admin affiliate ledger's Waiting → Rewarded flip (e.g. `Jess → Piper`). Register: CUSTOMER (Rule 1). Serves `docs/tacet-consolidation-decisions.md` §62: the affiliate is told through the existing in-app inbox, not a new push channel, automatically per reward rather than a manual broadcast.

| key | EN | CN | provenance |
|---|---|---|---|
| `affiliateRewardTitle` | Referral reward paid | 邀请奖励已到账 | **COMPOSED** under Rule 4's standing delegation |
| `affiliateRewardBody` | `{name}` placed their first order — ¥`{amount}` has been added to your wallet. | `{name}`完成首单，¥`{amount}` 已存入你的钱包。 | **COMPOSED** under Rule 4's standing delegation |
| `affiliateCategoryChip` | REFERRAL | 邀请奖励 | **COMPOSED** — reuses `affiliateRewardTitle`'s CN half rather than minting a second |

**HOW IT WAS ARRIVED AT.** No live string anywhere says "your reward has landed", so the title's lead clause is lifted whole from the refund notification this document already locks — `退款已到账` → `已到账`, the same in-app inbox saying the same thing about a different credit to the same wallet. `邀请` and `奖励` are both already live on the customer's own affiliate page (`邀请好友`, `邀请码`, and that page's own section title `收获奖励`); this is the first place the two are put together as one title. The body reuses `完成首单` and `你得 ¥{amount}` verbatim from that same page's own share copy (`TA 完成首单后你得 ¥{you}`), naming the specific friend instead of "TA" because the notification fires after the fact and already knows who it was; `钱包` is the wallet page's own name (`钱包与积分`) for the balance being credited.

**One live candidate was considered and rejected.** The affiliate page's own section title, `收获奖励`, was not reused as the notification's title, because it names a whole SECTION of that page (the stats block plus the invite list), not one credited event — a notification borrowing a section header would read as "go look at your rewards", not "this reward just happened".

**Falls back to `朋友` / `Your friend` when the invited customer has no nickname on file** — both already live as the generic word for the other side of an invite (`把邀请码发给朋友`).

Ash should correct any of this if it reads wrong; nothing depends on the exact phrasing.

**AMENDED 2026-09-07 — the admin toggle for this category.** `docs/tacet-consolidation-decisions.md` §62's follow-up amendment adds a switch (Marketing → Broadcasts → Automatic updates) so a tenant can mute this notification. Its row needs two more strings, both REGISTER: OPERATOR (Rule 1) rather than customer, since this label is read by staff, not the affiliate:

| key | EN | CN | provenance |
|---|---|---|---|
| `affiliateToggleTitle` | Referral rewards | 邀请奖励 | REUSED — the same pair `affiliateCategoryChip` already locks above |
| `affiliateToggleSub` | Sent to the referrer when their reward is credited | 邀请奖励到账时发送给邀请人 | **COMPOSED** under Rule 4's standing delegation |

**`affiliateToggleSub` follows the shape the sibling Invoices row already uses** — `Sent when an invoice is issued for an order · 订单开具发票时发送` — reusing `发送` (sent) and the live clause `到账` this whole section is built on; `邀请人` is the mini app's own live word for the referrer (`referredByLabel` on the affiliate page), not a new coinage for the same person the customer-facing strings above call "you".
