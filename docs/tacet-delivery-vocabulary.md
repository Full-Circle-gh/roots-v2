# Tacet delivery vocabulary — locked

**v1.72 · 2026-09-13 · §113 — adds an amendment section, Not arrived yet — the claim that becomes an order, locking ONE PAIR TAKEN VERBATIM and THREE COMPOSED, every Chinese term in them lifted from a live pair.** A claim for goods that have not arrived now raises an Ordered purchase order on approval, so the delivery can be tracked and received; the phone asks the one question, and the approver's queue says what approving it will do. `到货` comes off `Arrives · 到货`, `尚未` off `Not on any purchase order yet. · 尚未出现在任何采购单中。`, and `记入采购单` is v1.70's own pair from §111 part two. `Open purchase order · 查看采购单` is taken whole from the Finance screen that already uses it for exactly this jump. A test case re-reads each source and fails if any of them stops being live, so a rename cannot orphan the compositions. Rules 1 to 7 unchanged. **v1.71 · 2026-09-13 · §112 — ADDS an amendment section, Managing permissions from the phone, locking THIRTY-EIGHT COMPOSED PAIRS, FOUR ARRANGEMENTS OF LIVE SENTENCES and NINETY-SIX VERBATIM LIFTS.** Settings → Team is on the phone in full, and its vocabulary is the desktop Team tab's own: every label the desktop ships is used unchanged rather than reworded for a smaller screen, because two surfaces saying the same thing two ways is how a shop stops being sure they are the same setting. Four sentences that name WHERE a thing is have that clause moved and nothing else. The thirty-eight composed pairs are the screens the desktop has no equivalent of — an access switch, a credential receipt, and the lines that say which capability is missing — each built from characters already in service, with the candidates rejected recorded beside them. `许可` is spent on the `team:permissions` capability in three sentences and nowhere else, to stop `需要设置权限的权限`. Rules 1 to 7 unchanged. **v1.70 · 2026-09-13 · §111 part two — adds an amendment section, Was this ordered from a supplier?, locking TWO PAIRS TAKEN VERBATIM and SIX COMPOSED, every Chinese term in them lifted from a live pair and four of the six from this same screen.** The Transactions form now asks, once per category, whether what is being typed was ordered from a supplier — a purchase belongs on a purchase order, where it carries a supplier, a receiving step, a 发票 to match and something to return it against; rent and wages belong exactly where they are. Nothing here is a new WORD: `采购单`, `记入`, `支出` and `财务` all come off pairs already live in `22-finance.js`, and `供应商` and `下单` off `16-purchasing.js`. What is composed is the arrangement — the question itself, its two answers, the sentence that says when the money reaches the books, the toast for a category that has already been answered, and the settings label that can take the answer back. Rules 1 to 7 unchanged. **v1.69 · 2026-09-13 · adds an amendment section, Payment and delivery — three untaught tender words on Reports, locking TWO PAIRS LIFTED VERBATIM (`meituan`, `eleme`) and ONE PAIR COMPOSED (`offline`, reusing the live `线下` fragment already inside `wechat_offline`/`alipay_offline`).** Reports → Sales → Payment and delivery's `dashRenderSplits` (`03-dashboard.js`) had no lookup entry for three real `payment_method` values — `meituan` and `eleme` (the literal method a channel order settles under) and `offline` (the pre-existing generic counter tender) — so all three rendered as bare, unpaired English words on both language settings instead of a bilingual label. v1.68 · 2026-09-13 · ADDS an amendment section, The verdict that had no Chinese half, locking ONE PAIR LIFTED WHOLE and NOTHING COMPOSED.** Channel sync's fifth verdict `unk` shipped as `['Name not checked', 'Name not checked']` — English on both sides on three surfaces (`01-core.js`'s shared `CH_STATE_WORD`, `09-products.js`'s channel dots, the phone's `csWord`) — held deliberately as a placeholder *while Ash sources the Chinese*, which is the default Rule 4's 2026-09-06 amendment repealed. Its Chinese half is now `尚未读取商品`, **lifted whole** from `29-channel-sync.js`'s own store line on the same page, where a store whose catalogue has never been read already reads it; only the Chinese half moves, re-paired with the shipped English rather than replacing it, with the candidates rejected recorded beside it. The `MT_PENDING_CN` / `EL_PENDING_CN` sets are untouched and still English. Rules 1 to 7 unchanged. **v1.67 · 2026-09-13 · §108 — ADDS an amendment section, The add toast for a meal not yet made, locking ONE COMPOSED ARRANGEMENT.** §108 made a sold-out fresh meal read `NEXT BATCH · 下批现做` to every shopper, and the add toast was the last surface still answering `已预订，加入购物车` / *Added — pre-order* — so a customer tapped one word and was told another. The toast now matches, and needs a sentence the app did not have. **ONE COMPOSED ARRANGEMENT, declared under Rule 4's 2026-09-06 delegation: `已加入购物车，下批现做`** — the app's own plain add toast joined to the badge the customer just tapped, in the comma shape the pre-order toast beside it already uses, with the candidates rejected recorded beside it. The grocery toast `已预订，加入购物车` is UNCHANGED and stays the word for a restock we have no date for. Rules 1 to 7 unchanged. **v1.66 · 2026-09-12 · §107 — ADDS an amendment section, Naming both counts on the stall card, locking ONE PAIR LIFTED WHOLE and ONE COMPOSED ARRANGEMENT.** The Channel sync page's per-channel stall line now names how many items need attention beside the push-target count it already showed, so the two counts §104 ruled must never be summed no longer read as a mismatch on the one screen that shows both at once. Desktop reuses its own live `N 个待处理` verbatim; the phone has no such sentence and gets one composed arrangement, `N 件商品待处理`, joining its own live `件商品` and `待处理` with candidates rejected recorded beside it. `lib/channel-sync-stale.js` and `lib/channel-sync-items.js` are unchanged. **v1.65 · 2026-09-12 · §106 — ADDS an amendment section, What is stopping the whole channel, locking THREE PAIRS LIFTED WHOLE and ONE COMPOSED ARRANGEMENT.** A channel that cannot push now says what is stopping it, once, on its own card. `验证中心风控，同步已暂停，需要人工验证` is the Meituan daemon's **own merchant alert, verbatim** — the most authoritative sentence anyone has written about that fault, already sent to the merchant when it happens. `同步已停` is the Eleme tab's own fallback for a store that is not syncing; `自` is the Orders page's "since". §105's sign-in arrangement is reused unchanged, and Eleme's `auth_required` and Meituan's `needs_login` — the same fault under two daemons' names — take the one sentence. **ONE COMPOSED PAIR, declared under Rule 4's delegation: `无法连接同步服务。同步已暂停。`** — the locked cannot-reach pair joined to the second clause of the daemon's own captcha alert, with the candidates rejected recorded beside it. Rules 1 to 7 unchanged. **v1.64 · 2026-09-12 · §105 — ADDS an amendment section, Why a push failed, locking NOTHING NEW: SIX PAIRS LIFTED WHOLE and TWO ARRANGEMENTS.** A failed stock push now says why instead of *retries exhausted*. Every sentence is built from strings already live: `无法连接同步服务` (Meituan tab), `已退出登录` and `重新登录` (both channel tabs), `找不到该商品` (Eleme tab), `尚未读取商品` (Eleme store line) and `多次重试仍失败` (both daemons' own logs). **THE PLATFORM'S OWN REFUSAL IS SHOWN VERBATIM, IN THE SHAPE WECHAT'S ERROR ALREADY USES**: `微信支付未通过校验。微信返回：` is live for exactly this job — labelling a platform's sentence about its own refusal — so `美团返回：` is that shape with the channel name, not a new construction. Translating Meituan's `msg` was never on the table: it is the platform's account of its own decision and anything we wrote in its place would be less accurate. Two arrangements only, both of live fragments. Rules 1 to 7 unchanged. **v1.63 · 2026-09-12 · §103 step 5 — RETIRES FIVE LIVE PHRASES AND ONE WRONG CHARACTER, LOCKING NOTHING NEW.** The three channel tabs now take every state word from one table in `01-core.js`. Five phrases are retired because another tab already had a word for the same state: `未关联` and `待选规格` (Meituan), `已就绪 · 同步关闭` and `未上架饶了么` (Eleme), and Meituan's English-only *Name not in catalogue*. **`未上架饶了么` CARRIED 饶 (ráo) WHERE THE PLATFORM IS 饿 (è)** — live in the admin for as long as that screen existed, while `饿了么` sat correct in three other files. Retired with the label; the same 饶 in that tab's no-listing-name sentence is corrected in place to `饿了么商品名`. **The v1.62 entry below cited `未上架饶了么` as a source for `未上架` and so repeated the typo into this document; that citation is corrected.** Nothing is composed: every surviving word is a pair already locked here. Rules 1 to 7 unchanged. **v1.62 · 2026-09-11 · ADDS an amendment section, Which items a channel holds a wrong number for, locking ONE COMPOSED PAIR — `Channel sync · 渠道同步`, the page's name — and THREE ARRANGEMENTS of live strings** for §103. Every state word on the new page is a live pair lifted whole from the Meituan and Eleme tabs (`已同步`, `待处理`, `已关闭`, `未上架`), every reason phrase likewise (`找不到该商品`, `未选规格`, `缺商品名`, `待填名称`, `门店未关联`, `发送中…`, `推送失败`, `从未同步`), and the dashboard row reuses the tabs' own `N 个待处理` shape. **`渠道同步` IS COMPOSED** because no live string names a page that is about all three channels at once — `渠道` is live in `前往渠道`, `渠道与配送` and the Sales cards, `同步` in `已同步` / `未同步` / `同步开始`, and the compound is the plain noun for what the page is. `渠道商品待处理` was drafted for the dashboard row and DROPPED: restructuring the row to carry the page's own name and the tabs' live count shape left nothing to compose. Composed under Rule 4's standing delegation, by Claude Fable 5.1. Rules 1 to 7 are unchanged. **v1.61 · 2026-09-11 · ADDS an amendment section, When pre-orders open, locking ONE COMPOSED PAIR** for §102. The pre-order window gains a tenant-set START beside the cut-off §85 gave it, and the row needed a label. **BOTH HALVES WERE ALREADY ON THE SCREEN**: `预订` is live twice in the same card (`预订截单`, `预订可售数量`) and `开始` is live as `同步开始`, the per-store *"Sync starts"* field governing the very gate this row widens — so `预订开始` is an arrangement of two strings the operator has already met, not a mint. **`预订开始时间` AND `开始预订` WERE DRAFTED AND DROPPED**: the first because the row carries a `:00` suffix and its three sibling hours all name the event rather than the time of it, the second because a verb phrase reads as a button on a number field. Composed under Rule 4's standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. **v1.60 · 2026-09-11 · ADDS an amendment section, The hour the kitchen's own request is raised, locking NOTHING NEW FOR THE REQUEST ITSELF — ONE PAIR LIFTED WHOLE and TWO ARRANGEMENTS of live strings** for §101. The night's pre-orders raise one kitchen request in the morning; its purpose, slip header and note are all already live (`用于发货`, `厨房新请求`, `有客户订单等待`), and the only new text is one settings label and its description, arranged from `厨房制作请求` (live whole in `routes/restock.js`), `时间`, `每天` and `留空则…`. **`自动制作请求时间` WAS DRAFTED AND DROPPED**: an hour in a settings field is what automatic looks like, and calling it auto implies a manual twin that does not exist. Arranged under Rule 4's standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. **v1.59 · 2026-09-11 · ADDS an amendment section, Naming the channel a conversion rate belongs to, locking NOTHING NEW: ONE PAIR LIFTED WHOLE and TWO ARRANGEMENTS of live strings** for §100. Home's second card and the desktop's conversion cell now say which channel their figures are counted over. **THE WORD WAS ALREADY ON THE PHONE, ONE TAB ACROSS**: the Orders screen's channel chips have shipped `{key:'miniapp', en:'Mini app', zh:'小程序'}` against the same `wechat` channel this card now reads, so the operator has already learned this label for exactly this population and nothing was minted to reuse it. `转化率（小程序）` and `N 单（小程序）÷ M 次会话` are arrangements of that lift with `转化率`, `单 ÷` and `次会话`, all three live on the phone's own card. **`小程序订单` WAS DRAFTED AND DROPPED**: a compound noun for "mini-app order" is live in zero files, and the parenthetical keeps the two halves as the two live strings they are. **`小程序浏览` AND `小程序下单` ARE THE FUNNEL'S TWO ROWS**, arrangements of the same lift with `浏览` and `下单` — the rows read `到店浏览` and `下了单` while counting a session denominator only the mini app can produce. Arranged under Rule 4's standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. **v1.58 · 2026-09-11 · ADDS an amendment section, Evidence on a late-parcel case, locking ONE COMPOSED PAIR and recording FOUR LIFTED VERBATIM** for §98's last two open items. **THE BANNER HEADING WAS RESTRUCTURED RATHER THAN TRIPLED**: widening the alert from air-only to every mode needed a heading that fits a land parcel and a same-city rider, and the obvious route was `空运延误` plus a new `陆运延误` and `同城配送延误` — instead the heading became mode-neutral and **`配送延误` is already live** inside `配送延误送达`, the customer's own delayed-delivery notification. One lift in place of two mints, and the card states the mode beside it anyway. `添加照片` is the only thing composed, out of `添加` and `照片`; `凭证`, `查看` and `删除` are lifted whole. Composed under Rule 4's standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. **v1.57 · 2026-09-11 · ADDS an amendment section, "Not today" on a waiting fapiao, locking ONE COMPOSED PAIR and recording ONE LIFTED for §99's snooze.** The control that defers a fapiao push to tomorrow, on the phone's Invoices screen. **ONE STRING CARRIES BOTH STATES**, because the control is the app's own `.chip` and its `on` fill already says "set" — a second pair for the set state (`已推迟`, `已暂停`) was drafted and dropped as a new word for what the fill says, neither candidate being live here. **NO DATE IS PRINTED**: the button promises tomorrow and the server writes tomorrow, and a timestamp beside it would be a second source for one fact. `明天提醒我` is an arrangement of `明天` and `提醒我` (`应用关闭时也提醒我`); `提醒已恢复` is lifted from `发送测试提醒` and `整单已恢复待开票`. **`忽略` AND `跳过` WERE REJECTED AND THE REASON IS THE FEATURE**: both describe a dismissal, and a dismissal is exactly what this is not — a swipe writes nothing, and a word that made the two sound alike would undo the distinction §99 rests on. Composed under Rule 4's standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. **v1.56 · 2026-09-11 · ADDS an amendment section, The fapiao that asks again, locking TWO COMPOSED PAIRS and recording ONE LIFTED VERBATIM for §99's fapiao chase.** The Web Push an operator now gets when a 发票 a customer asked for has not been issued, and the switch that mutes it. **THREE PAIRS FOR A WHOLE FEATURE IS THE POINT, NOT AN OVERSIGHT**: the ordinary push title is the live pair Home's row has always printed, the per-order body is an order number, a sum and a name — none of which needs a label in either language — the digest body is a count and an age carrying the live `最久` tail, and Home's month-end escalation adds no string at all because the colour is the message. That is Rule 4's stated preference working rather than being worked around. **NEITHER COMPOSED PAIR INTRODUCES A WORD THIS REPOSITORY DID NOT ALREADY SHIP** — both are arrangements of `本月`, `开票`, the `X内` construction, `顾客`, `申请`, `尚未` and `开具`, each checked against the tree. **`逾期` WAS REJECTED AND THE REASON IS RECORDED**: a 发票 unissued on the 29th is not late by any promise to the customer, it is approaching a TAX boundary, and a word that asserts a broken agreement would be a lie about the shop. Composed under Rule 4's standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. **v1.55 · 2026-09-11 · ADDS an amendment section, A carrier's compensation in the ledger, locking TWO COMPOSED PAIRS for §98 stage four.** The refusals the Transactions screen answers with when somebody tries to edit or delete the `income_entries` row a delay case posted — the first projection this ledger has ever had on the money-IN side. **BOTH ARE THE CLAIM REFUSAL WITH ONE NOUN PHRASE SWAPPED**: `费用申请产生的支出不能直接编辑` is live in that same catalogue for the money-OUT projection, so `费用申请` becomes `承运商赔偿` (locked in v1.54) and `支出` becomes `收入` (live in eight files), with `产生的`, `不能直接编辑` and `不能直接删除` carried across untouched — the parallel being the point, since a bookkeeper who has met one refusal should recognise the other as the same rule about a different document. `承运商赔偿` is REUSED, not re-minted: one fact, one pair, now three places. **NOTHING WAS COMPOSED FOR A CATEGORY** — the obvious move was an income category reading *carrier compensation*, and the income list ships empty by §36 so the form cannot offer a wrong option, so the posted row carries none and a pair minted here would have seeded that list by the back door. Composed under Rule 4's standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. **v1.54 · 2026-09-11 · ADDS an amendment section, Chasing the carrier on a spoiled parcel, locking SEVENTEEN COMPOSED PAIRS and recording FIFTEEN LIFTED VERBATIM for §98's late-parcel case.** The four steps that replaced the single "Mark handled — customer contacted" button on a delayed air parcel, on both surfaces. **NOT ONE OF THE SEVENTEEN INTRODUCES A WORD THIS REPOSITORY DID NOT ALREADY SHIP** — all seventeen are arrangements of `承运商`, `赔偿`, `申请延误赔偿`, `补发`, `退款`, `已拒绝`, `已撤销`, `单号`, `金额`, `收到`, `原因`, `步骤`, `全部`, `完成`, `方可`, `关闭`, `尚未`, `以上`, `或`, `向` and the `已` prefix, each checked against the tree rather than assumed. **THE ONE THING THAT COULD NOT BE CARRIED FORWARD IS THE CARRIER'S NAME**: the live pairs said `联系京东物流，申请延误赔偿。` and `并向京东申请延误赔偿。`, and §98 refuses a carrier name anywhere in this feature because the claim is against whichever company carried the parcel — `向承运商申请延误赔偿` is that sentence with the company replaced by the live word for the role, and that one substitution is why most of the section exists. `已联系客户` and the perishable warning are LIFTED WHOLE out of the button and banner being removed. **`reason_required` and `amount_required` were deliberately NOT added**: both already exist in `01-core.js` worded for this exact situation, the first draft duplicated them, `no-dupe-keys` caught it, and it is recorded so the next person reaches for the catalogue before writing a sentence. Composed under Rule 4's standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. **v1.53 · 2026-09-10 · ADDS an amendment section, Paying with points or the wallet at the counter, locking TWO COMPOSED PAIRS and recording TWO LIFTED VERBATIM for §93's store credit at the till.** The four are the refusals `POST /api/retail-admin/orders` can now answer with when a hand-keyed order tries to spend points or wallet balance, and they render on both order forms — neither of which can actually cause them, the counter till being the caller that can. **`积分不足。` and `余额不足。` ARE NOT COMPOSED** — the first is quoted whole from the admin's own shared error catalogue for this same code, the second is the pair the web storefront and the mini app both already ship for it. The two that are composed are arrangements of words already live in the tree — `积分`, `余额`, `顾客`, `账户`, `金额`, `请选择`, `付款方式`, `剩余`, and `不足` in the shape `积分不足` — checked against the tree rather than assumed. They exist because no screen in this product has ever had to say that a tender fell short of the bill: until §93 no hand-keyed order had a tender that could. Composed under Rule 4's standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. **v1.52 · 2026-09-10 · ADDS an amendment section, Who put the row in the books, locking TWO COMPOSED PAIRS for §92.** `审批人` and `录入人` name the person a ledger row records as having put it there — the approver on a claim-posted row, the typist on a hand-typed one. **BOTH ARE A LIVE WORD PLUS THE SUFFIX OF A LIVE PAIR ON THE SAME FEATURE, which is the cheapest a new pair gets after an outright lift.** `审批` ships on the approvals screen as `待审批`, `审批通过后即记入本月账目。` and `审批费用申请`; `录入` ships in this register as `可录入交易` (the Bookkeeper role, which is this exact act on this exact screen), `仅手动录入` and `可随时录入库存`; and the `人` suffix is lifted from `Asked by · 申请人`, the approvals queue's own column for the other person on the same claim. **THE TWO PAIRS EXIST SEPARATELY BECAUSE THEY NAME TWO DIFFERENT ACTS** — approving somebody else's spending is an authority §87 built a capability around, typing a row is not — and §92 records why one label over both was refused. **NO THIRD PAIR FOR AN UNRESOLVED NAME**: the row renders no meta at all, §1.12 preferring an empty cell to an invented one, and the live `Someone · 未知` stays where it belongs on the approvals queue. Composed under Rule 4's standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. **v1.51 · 2026-09-10 · ADDS an amendment section, Voiding a posted claim, locking FOUR COMPOSED PAIRS and recording THREE LIFTED VERBATIM for §90's Void action.** It serves the new `expenses:cancel` capability and its screen: the Transactions row's Void link and the Approvals queue's status pill. **`作废` and `已作废` ARE NOT COMPOSED — they are LIFTED VERBATIM from the waste ledger's own Void control** (`public/retail-admin/20-waste.js`, gated on the sibling capability `waste:void`), which already ships `T('Void', '作废')`, `T('Voided', '已作废')` and `T('Voiding…', '作废中…')`. The confirm dialog's title, `Void this claim?` · `作废这条费用申请？`, is **COMPOSED as a direct noun-swap of that same screen's own `Void this waste entry?` · `作废这条损耗记录?`** — the shape is proven and only the object changes. The dialog's body is **LIFTED VERBATIM, unchanged**, from the Transactions Delete confirm already on this same screen. The capability's own label, `Void a posted claim` · `作废费用申请`, is **COMPOSED from two live words** — `作废` and `费用申请`, live as the Expense claims section name and the existing `Staff claim · 费用申请` mark. The two refusal strings are each the **PO/claim refusal shape §87 already established**, one word swapped. Composed under Rule 4's standing delegation, by Claude Sonnet 5. Rules 1 to 7 are unchanged. **v1.50 · 2026-09-10 · ADDS an amendment section, Where the sales are, locking ONE COMPOSED PAIR — and both of its Chinese words were already locked in this document.** `营收见汇总` is Ruling 1's `营收` and the Finance table's `汇总` with `见` between them; the composition adds one live character to two locked words, which is the cheapest a new pair gets. **THE STRING EXISTS BECAUSE A CORRECT FIGURE WAS UNREADABLE**: Ash reported money in showing ¥0 on the live screen, the natural reading being that Finance is broken, when §36 keeps orders off that list by decision and `income_entries` has held no row since 31 July. The figure was right and the screen said nothing. **THE FIRST INSTINCT — RELABELLING THE TILE `其他收入` — IS REJECTED BY RULING 1**, which reserves `收入` for Income and is enforced by a test that fails the build if it renders on Finance at all; the rename would also not have answered the question the operator arrived with, which is where the sales went rather than what the tile is called. `Money in · 进账` is untouched. Rules 1 to 7 are unchanged. v1.49 · 2026-09-10 · ADDS an amendment section, Choosing from thirty-one, locking FIVE COMPOSED PAIRS for the expense category picker — and five of the seven strings it needs are two live words each.** `选择`+`分类`, `搜索`+`分类`, `最近`+`使用`; `全部分类` is not composed at all, shipping today on the product catalogue, and reusing it is what makes the picker read as a control the operator has already met. `没有匹配的分类。` is the product's own empty-search sentence with its noun swapped (`没有匹配的商品`, `没有匹配的物料`), because a third way of saying *nothing matched* would suggest a third kind of nothing. **`常用` REJECTED for the recents heading**: it claims a frequency ranking the query does not compute — the section is this person's last five categories, newest first — and `最近使用` says exactly what the code does, so a later change to a real frequency count would make the label visibly rather than plausibly wrong. Also rejected: a pair naming how many categories the list holds, which advertises the length of a list this control exists to stop anybody reading. Composed under Rule 4's standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. v1.48 · 2026-09-09 · ADDS an amendment section, Paying it back, locking NINE COMPOSED PAIRS for settlement (§87 step four) — and its line completes a SET OF THREE written to be read together.** Under Submit `审批通过后才会记入账目。` (not yet); under the queue `审批通过后即记入本月账目。` (approving records it); under the owed block `标记已付不会改动账目 — 该费用在审批通过时已记入。` (and paying it back changes nothing). The third is the least obvious of the three, which is why it exists: a screen showing money and a button, with no line under it, invites somebody to think the button spends something. **`报销` IS REJECTED A SECOND TIME, on the button v1.46 reserved it for.** `标记已付` says what the control does — records a payment already made elsewhere — while `报销` names a process the shop runs, and would suggest this app pays the money out, which it does not. The word stays unspent. `标记已付` is `标记` plus the past form of `付款` (`已付款`, live); `应付团队` reuses the `应付` of `应付账款`. Two refusals rather than one, because an unapproved claim and a company-account one are refused for different reasons and a shared message sends somebody hunting a permission problem that is not there. Composed under Rule 4's standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. v1.47 · 2026-09-09 · ADDS an amendment section, Deciding a claim, locking TWENTY-THREE COMPOSED PAIRS for the approvals screen (§87 step three) — and its key line is the MIRROR of the one locked in v1.46.** The claim screen says `审批通过后才会记入账目。`; the approvals screen says `审批通过后即记入本月账目。` — same clause, opposite side, one word (`才会` → `即`) carrying the whole difference between *not yet* and *now*. **`本人提交` MARKS A SELF-APPROVAL RATHER THAN REFUSING ONE**, because §87 part five allows it and makes the record the guard; `本人` comes from `本人签收`. The two ledger refusals are the PO pair with one noun swapped (`关联采购单的支出不能直接编辑` → `费用申请产生的支出不能直接编辑`), deliberately, because a claim-posted row is refused for the same reason a PO row is and a second way of saying it would suggest a second reason. **`批准` REJECTED for the button**: `通过` is what this product already says about an approved payment (`款已通过`) and matches the `已通过` pill the other screen shows afterwards. Also recorded as a deliberate absence: there is no pair saying an approver may not approve their own claim, because there is no such rule. Composed under Rule 4's standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. v1.46 · 2026-09-09 · ADDS an amendment section, Saying what you spent, locking TWENTY-FIVE COMPOSED PAIRS for the phone's expense-claim screen (§87 step two) — and its two most important pairs exist to say the money is NOT in the books yet.** `审批通过后才会记入账目。` sits under the button and `尚未记入账目。审批通过后才会记录。` on the receipt; `记入账目` is lifted verbatim from the phone's own receiving copy (`采购金额记入账目`), so a cook who has received a delivery meets the phrase that means *this reaches the books* being used to say the opposite about a claim. **`报销` IS REJECTED AND LEFT UNSPENT**: it is the standard word for a reimbursement and it names the repayment, while this field names whose money was spent — half these claims are paid on the company account and are never reimbursed. It is the right word for the settlement step. `个人支付` and `公司` are the two answers; `应付您` is the debt, taking `应付` from `供应商发票金额即应付账款`, because an employee who fronted ¥38 is owed on the same footing as a supplier and a second vocabulary for one fact is how two numbers stop reconciling. A Note placeholder was REMOVED rather than composed — the English example needed two Chinese words this product does not ship, and Rule 4 prefers restructuring over minting. Composed under Rule 4's standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. v1.45 · 2026-09-09 · ADDS an amendment section, The tenant's own expense categories, locking TWENTY COMPOSED PAIRS for the Finance Categories sub-view and the excluded line beneath the Summary staircase (§87 part two) — and EVERY CHINESE WORD IN IT IS ALREADY LIVE, only the arrangements are new.** The phrase the decision turns on is `不计入营业费用`: the Summary's own row label `营业费用` with the live negation `不计入` (`物料不计入门店库存`, `其成本不计入`) in front of it, because the excluded line must read as the negative of the row above it or the card asserts two different ideas. Retiring a category reuses the team screen's `停用` / `启用` / `已停用` verbatim — **hiding a category is the same act, in the same words, as deactivating a teammate** — and `隐藏` was rejected for it: the category keeps governing rows already filed under it, which is deactivation rather than a display toggle. `租金` is used and `房租` is not, though both are in `22-finance.js`: `房租` lives only inside a comment about two spellings of one category colliding, and the string that surface actually ships is `您记录的租金、工资和一次性费用…`. Also rejected: any phrasing built on profit (`不计入利润`), which would name an arithmetic the screen deliberately does not perform — the money is out of the operating total and is NOT subtracted from net. Composed under Rule 4's standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. v1.44 · 2026-09-09 · ADDS an amendment section, Typing the quantity on Ask to buy, locking ONE COMPOSED PAIR — and it is a live sentence with two words taken OUT, not any put in.** §86 shipped with steppers only and Ash asked what happens when the kitchen needs 100 of something. The Add Stock card’s refusal (`请输入制作数量——整数，0 或以上。`) is reused minus `制作` (nothing is being MADE here) and minus `整数` (a material bought by the kilo can be asked for as 2.5; the column is REAL and the route takes any finite number above zero). Composed under Rule 4’s standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. v1.43 · 2026-09-09 · ADDS an amendment section, Asking the buyer to buy, locking NINETEEN COMPOSED PAIRS for the kitchen purchase request (§86) and recording the verbatim lifts beside them.** The pivot is `采购申请` rather than `物料申请`: this asks the company to BUY, not to draw material out of a store it already holds, and both of its words are live (`采购` on the Purchasing rail, `申请` inside `发起补货申请`). The capability label is that sibling with its noun swapped — `发起采购申请` — which is deliberate: an admin reading the matrix should see at a glance that one key moves Roots’ own goods and the other spends money. No price string exists anywhere on the kitchen’s screen, because the server sends no cost column to it. Composed under Rule 4’s standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. v1.42 · 2026-09-09 · ADDS an amendment section, The pre-order window, locking THREE PAIRS for §85's Fresh batches controls — and the one word that was not already ours is LIFTED FROM THE PLATFORMS THEMSELVES**, which is Rule 4's second preference and the right one here: this feature exists to publish to Meituan and Eleme, and both already have a word for an order placed ahead rather than now. `预订` is matched against Meituan's own store-status text in `lib/meituan-browser.js` (仅接受预订, that platform's merchant wording for "reservation only") and read from Eleme's `预订单` in `lib/eleme-browser.js` — the merchant-facing word on both screens this setting governs. Everything else is verbatim live: `可售数量` and `渠道` from `库存,以及各渠道可售数量`, `截单` from this card's own `当日截单`, and the channel names as they already ship (`美团`, `饿了么`, `gzgrocery · 管易`). The lock row is built to read as the SIBLING of the `当日截单` row two above it — one pair of deadlines, which is why `截单` was reused rather than a second verb found. Two candidates recorded as rejected: `预售`, the commoner word, which carries a product-launch sense this is not (nothing is being launched; a shelf is empty and the kitchen is three hours from filling it); and restructuring the allowance row to need no label at all, which §84's bare numerals could carry and a settings box between an hour and a row of checkboxes cannot — the one thing an operator must not misread is whether it counts per product or per order, and the label is what says so. Composed under Rule 4's standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. v1.41 · 2026-09-09 · ADDS an amendment section, What today's batch owes, locking ONE PAIR whose CHINESE HALF IS LIFTED VERBATIM and whose English half alone is composed.** It serves §84's owed block above 厨房制作队列's request list and the row it puts on the phone's Home. `有客户订单等待` is already live in `public/m.html` on the "Ask the kitchen" purpose picker, meaning exactly this — a customer order waiting on something the kitchen has to make — on the same screen, in the same register, to the same reader; Rule 4's first preference is to copy a live pair, so it is copied. Only the English moved, and only because the live half is a singular sentence about one request (*A customer is waiting on it*) and this is a heading over several products owed to many people; the Chinese needed no such change, being already number-neutral. **The half Rule 4 guards is therefore untouched.** Two candidates are recorded as rejected: `待制作`, live and on this very screen but live AS THE TAB the block sits above, whose list is requests somebody typed rather than orders customers placed; and naming *today's batch* in the heading, which `lib/batch-owed.js` deliberately cannot know is happening. The rows carry a name and a numeral and no third word. Composed under Rule 4's standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. v1.40 · 2026-09-09 · ADDS an amendment section, Three numbers about one pot, locking TWO COMPOSED PAIRS on the Recipes yield hints.** Both are sentences the recipe editor now says when a recipe's batch size disagrees with what its own ingredient lines add up to, or with its servings times its serving size. **Every Chinese word in both is already live in `public/retail-admin/19-recipes.js` itself** — nothing is new vocabulary, and the composition is the arrangement, not the words; the provenance table names the live string each word comes from. Composed under Rule 4's standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. v1.39 · 2026-09-09 · ADDS an amendment section, Guangzhou is not unaffected, locking ONE COMPOSED PAIR and CORRECTING a false sentence that shipped with the Fresh batches card and survived the v1.38 rebuild.** The card said in-Guangzhou orders are unaffected by the batch schedule; they are not — `earliestBatchMakeDate` runs with `localRun: true` and `localFreshFloorFor` floors a Guangzhou order onto the batch date on `rolled_stock`, which is what the card's own Guangzhou copy fields serve. Caught by Ash on the live page. The replacement states the narrower thing that is true. Composed under Rule 4's standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. v1.38 · 2026-09-09 · ADDS an amendment section, The Fresh batches card becomes a console, locking FOURTEEN COMPOSED PAIRS and recording nine verbatim label lifts and two verbatim sentence lifts.** It serves the Fresh batches rebuild to the A4 Console archetype, whose label+description rows are the reason any sentence had to be written at all. **Every Chinese word in all fourteen is already live in this product — none is new**, and `fbStateOn` is the delivery hub's own status chip verbatim. The seven glued `(中文)· English` labels §1.11 was failing on are not repaired but removed: dropping the `— English` / `— Chinese` suffixes collapses each pair of labels into one that was already live. Composed under Rule 4's standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. v1.37 · 2026-09-08 · ADDS an amendment section, An order arrived and some of it never came off the shelf, locking THREE COMPOSED PAIRS.** It serves the channel-ingest visibility work: both channel ingests now tell the merchant when an order carried a line that matched no product (stock NOT deducted) or a line the shelf could not cover. **All three pairs are assembled from live words and invent none**: 未匹配 is lifted verbatim from the products table's own "no match" pair, 库存不足 from the live low-stock pair, and 库存/扣减/需要/剩余/订单/商品 are all live on the stock surfaces. Composed under Rule 4's standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. v1.36 · 2026-09-08 · ADDS an amendment section, One staff app, one card, locking FOUR COMPOSED PAIRS and recording six verbatim lifts and six deletions.** It serves `docs/tacet-consolidation-decisions.md` §48 step 4: the standalone stock app is deleted, so the two Settings cards that advertised it under two names — *Quick Stock* and *Add Stock* — become one card naming the app that actually opens. Composed under Rule 4's standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. v1.35 · 2026-09-08 · ADDS an amendment section, The receive screen records itself, locking ONE COMPOSED PAIR and recording six verbatim lifts and two deletions.** It serves `docs/tacet-consolidation-decisions.md` §70: the receive screen has no save button any more, so the strings that described one are gone and the ones that describe a screen saving itself are, with a single exception, words this phone already ships. **The composed pair adds no new word**: its first half is the screen's own existing short-line warning kept verbatim, and its second is the 「X的不会Y」 shape of the Add-stock screen's live `已登记的不会重复计入`. Composed under Rule 4's standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. v1.34 · 2026-09-08 · ADDS an amendment section, Saving several sizes at once, locking ONE COMPOSED PAIR.** It serves `docs/tacet-consolidation-decisions.md` §68: the phone's product sheet now carries a whole variant family, so Save writes several products where it used to write one — and the one failure message it had, *没有保存成功。数据没有变化 — 请重试。*, becomes false the moment one write of several has landed. **The composed pair is assembled from three live fragments and invents no word**: 部分 (this file's own partial-arrival vocabulary), 没有保存成功。 (the sheet's own existing failure), and 不会重复 plus 请再按一次「…」 (the Add-stock screen's partial-failure line, which is the same situation on another screen). Composed under Rule 4's standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. **v1.33 · 2026-09-08 · ADDS an amendment section, An urgent kitchen request, locking SIX entries, FIVE COMPOSED AND ONE REUSED.** It serves `docs/tacet-consolidation-decisions.md` §65: "Ask the kitchen" gains a third purpose, `urgent`, which sorts the kitchen queue rather than only colouring a card. **Nothing lived for "urgent order" as a pair, but every character in it did** — `加急` is live in retail-admin's same-day delivery block (`当日达加急`) meaning precisely this, `优先` is live twice on the dashboard, and `制作` and `等` are live on the request screen itself. `紧急` was rejected as the wrong register: it is the word for an emergency, and this is a scheduling instruction. Composed under Rule 4's standing delegation. Rules 1 to 7 are unchanged. v1.32 · 2026-09-08 · adds an amendment section, The phone is holding only part of the catalogue, locking THREE entries, TWO REUSED AND ONE COMPOSED.** It serves `docs/tacet-consolidation-decisions.md` §64: the phone now walks the whole product catalogue instead of reading the first 500 rows of it, and where the walk stops short the screen names the fraction it is holding rather than drawing four counts about a prefix. **The composed pair is a near-copy of one already shipping** — `public/retail-admin/01-core.js`’s J-01 truncation banner, whose first sentence is taken as it stands, with 件 lifted from this same phone screen’s own catalogue footer. **What was rejected is that pair WHOLE:** its second sentence sends the reader to search and filter, which reach the missing rows on the desktop because they are the server’s and cannot reach them on the phone because they are not — the affordance that is true here is a Try again, and that is a live pair, not a new sentence. The other two entries are verbatim reuses of strings already on this screen. Composed under Rule 4’s standing delegation, by Claude Opus 5. Rules 1 to 7 are unchanged. v1.31 · 2026-09-07 · AMENDS *Affiliate reward notification — the mini app inbox* with the admin toggle row, locking TWO more entries, ONE REUSED AND ONE COMPOSED.** It serves `docs/tacet-consolidation-decisions.md` §62's second amendment: a tenant can now switch the affiliate reward notification off from Marketing → Broadcasts → Automatic updates, the same folded panel that already toggles Order/Invoices/Refunds — no server code changed, because `notifyCustomer()`'s category mute was never hardcoded to those three. **The row's title is the SAME `邀请奖励` pair this section already locks for the notification itself and the category chip** — a fourth reuse of one pair rather than a fourth string for one concept. **The subtitle is COMPOSED, on the sibling Invoices row's own shape** (`Sent when an invoice is issued for an order · 订单开具发票时发送`), reusing `发送` and this section's own `到账`, with `邀请人` — the affiliate page's own live word for the referrer (`referredByLabel`) — naming who receives it. Composed under Rule 4's standing delegation. Rules 1 to 7 are unchanged. v1.30 · 2026-09-07 · adds an amendment section, Affiliate reward notification — the mini app inbox, locking THREE entries, ALL COMPOSED FROM LIVE FRAGMENTS.** It serves `docs/tacet-consolidation-decisions.md` §62: the affiliate ledger's Waiting → Rewarded flip now tells the referrer, automatically, through the mini app's own in-app inbox — the same `retail_notifications` path refund/invoice/feedback events already use, never a new push channel and never the operator-composed `retail_broadcasts` campaign feature, which this event does not fit (one recipient, decided by an order paying, not by an admin composing anything). **Nothing lived for "your reward has landed" as a sentence, but every WORD in it did** — the title's lead clause `已到账` is the same clause this document already locks on the refund-paid pair, and `邀请` / `奖励` / `完成首单` / `你得 ¥{amount}` / `钱包` are all lifted from the affiliate page's and the wallet page's own live copy, so what is composed is the sentences that put them together and not the vocabulary inside them. The category chip reuses the title's own CN half rather than minting a second string for the same concept. One live candidate — the affiliate page's own section title `收获奖励` — was considered for the notification title and rejected, because it names a whole section of that page rather than one credited event. Composed under Rule 4's standing delegation, with the usual correction caveat. Rules 1 to 7 are unchanged. v1.29 · 2026-09-07 · EXTENDS *A batch that could not be matched to a shelf* with FOUR MORE PAIRS, ALL COMPOSED, for the refusals that used to say nothing at all.** It serves `docs/tacet-consolidation-decisions.md` §59 as amended a third time: every path out of the kitchen queue that does not reach the record screen now names itself on the queue it drops back to. **No section is opened, because these are the same screen's remaining states** and a reader looking for what the handover says should find all of it in one place. **The lead clause is REUSED, not re-minted** — `但库存尚未登记` is the clause v1.28 locked one section-entry above, and `已标记完成` is live in both files — so what is composed is three reason clauses and the sentence that carries them. **`登记生产批次` IS QUOTED FROM `lib/capabilities.js`, and quoting it is the point of the string**: it is `production:log`'s own label, the words an admin reads on the permissions screen, so an operator who is refused can ask for the right thing by name instead of reporting a blank screen — a refusal that names a capability in different words from the screen that grants it sends two people hunting. `此账号无法…` follows the live refusal pattern already in both files (`此账号无法处理厨房队列。`). **The rejected alternative is recorded**: a single generic sentence for all three refusals was considered and dropped, because the three are acted on by three different people — an admin grants the permission, an owner adds the store, and the person who raised the request fixes its quantities — so one sentence would tell none of them what to do. Composed under Rule 4's standing delegation, with the usual correction caveat. Rules 1 to 7 are unchanged. v1.28 · 2026-09-07 · adds *A batch that could not be matched to a shelf*, locking SIX entries of which FOUR ARE COPIED VERBATIM AND TWO ARE COMPOSED.** It serves `docs/tacet-consolidation-decisions.md` §59 as amended a second time on 2026-09-07, which stops the kitchen queue's handover refusing on a shelf that has merely not loaded yet and on lines it cannot match. **The screens gained two states they had never had — waiting, and a shelf that failed — because until now they had refused to open at all in both, which is the defect.** `加载中…`, `货架加载失败。`, `重试` and `登记批次` are all live in the same two files and are taken verbatim; **what is composed is one CLAUSE and the two sentences it sits in**, and the clause is `但库存尚未登记` — *but nothing has been added to stock yet*. **No live pair says it**, because no screen in this product has ever had to tell somebody that a step they just completed left the stock untouched: the request closes and the shelf is still short, which is the whole gap §59 exists to close. **One live pair is REJECTED and the rejection recorded**: `Stock pending · 库存待扣`, §58's operator note, is the closest live string about stock that has not moved and is not taken, because `待扣` is stock waiting to be DEDUCTED by an order leaving and this is the opposite direction — units that were MADE and have not been added — so reusing it would put the deduction vocabulary on a production write. **The live `货架加载失败。` alone was also considered and is kept as the opening clause rather than as the whole message**, because it names what failed and not the two facts the operator has to act on: the request is already closed, and there is no way back to it. Composed under Rule 4's standing delegation and carrying the usual correction caveat. Rules 1 to 7 are unchanged. v1.27 · 2026-09-07 · AMENDS *Typing a batch into Add stock* IN PLACE — the control moved from a sheet to the count cell itself, and NOT ONE STRING IS MINTED OR RE-TRANSLATED BY IT.** It serves `docs/tacet-consolidation-decisions.md` §60, which rules that a kitchen types its batch on the card and a recount keeps the sheet. The three pairs v1.26 locked change only which element carries them — title to `aria-label`, confirm button to card button, validation line unchanged — and `Quantity · 数量` is **RETIRED on this screen** and recorded as retired rather than struck out, because it stays live elsewhere in `public/m.html` and the reason it went is worth keeping: a field with the count already in it, on a card naming the product, leaves a label above it nothing to say. **The amendment is written into the v1.26 section itself rather than opening a new one**, since a section about a screen whose control has been replaced is misleading read alone. Rules 1 to 7 are unchanged. v1.26 · 2026-09-07 · adds *Typing a batch into Add stock*, locking FOUR entries of which THREE ARE COPIED VERBATIM AND ONE IS COMPOSED — and the ratio is the whole point.** `public/m.html`'s Add stock card let a count be TYPED in recount mode and not in add mode, so a kitchen logging 130 bowls of soup tapped `+` a hundred and thirty times; `public/stock.html`, the sibling kept 1:1 with it, has opened its keypad from the count in both modes since that screen existed. **Giving add mode the door recount already had needed almost no new words, because the sibling had already written them**: `How many did you make? · 制作了多少?` and `Add to stock · 加入库存` are that keypad's own label and save verb, taken verbatim — the first is the very pair the v1.21 section built `在架有多少?` parallel to — and `Quantity · 数量` was already live in this file. **The single COMPOSED pair is the live validation sentence with one noun swapped**, on the `statStripEmpty` precedent: `请输入在架数量——整数，0 或以上。` keeps its structure, its em-dash break and its whole tail, and only `在架数量` becomes `制作数量`, where `制作` is the page's own live word. **Two live candidates are REJECTED and both rejections recorded**: `请输入到货数量 — 0 或以上的整数。`, the closest live sentence by shape, because `到货` is goods arriving from a SUPPLIER and a kitchen that cooked the soup received nothing — the same class of collapse §46 prevents between a batch and a recount; and `每家门店请输入 0 或以上的整数。`, whose qualifier names a per-store grid this one-product field is not. **The section also records what carries NO string:** the count gained a visible edge so it can be told from the label above it, and no words, because a numeral needs no label. Rules 1 to 7 are unchanged. v1.25 · 2026-09-07 · adds *The two doors into a shop — the till and the QR menu*, locking TWO entries, BOTH COMPOSED.** It serves `docs/tacet-consolidation-decisions.md` §44 as amended 2026-09-07, which names `retail_orders.shop_entry_method` — values `till` and `qr` — as the column that tells a shop's two doors apart, and NOT `retail_orders.source`. **Nothing could be copied, and the reason is structural rather than an oversight**: no screen in this product has ever had two doors into one shop to name, the web store and the mini app each having exactly one way in and the till having been the only way into a counter until the QR menu existed. **Every TERM in both sentences is nonetheless live** — `门店` from the shop channel's own label, `前台` from the `前台销售` refusal already locked in the very map these two join, `二维码` from the admin's share-card and payment-code panels — **so what was minted is the sentences and not the words.** **Two live candidates are REJECTED and both rejections recorded**: `Shop menu · 门店商品`, the closest live pair to "the QR menu", because it names the ADMIN's shop-listings editor and would make one string mean two screens; and `请选择订单来源。`, the nearest live sentence, because it asks for an ORIGIN — how the customer reached the business — and §44 is explicit that a shop's door is not an origin. **Three server codes share the two sentences**, on the house precedent of `bad_fulfillment_type` and `fulfillment_type_required` sharing theirs in the same map. **The cost is named rather than hidden**: neither sentence is reachable from the New order form, which offers no `shop` channel and sends no door, so both are locked for a state nobody can currently reach — bought because the endpoint serves other callers and because `verify-fulfilment-types.js` fails the build over a server error with no home on the page. Rules 1 to 7 are unchanged. v1.24 · 2026-09-06 · adds *The kitchen's printed request slip*, locking twenty-one entries of which FIFTEEN ARE ALREADY LIVE AND SIX ARE COMPOSED — and the ratio is the section's point.** It serves `docs/tacet-consolidation-decisions.md` §51, which rules that a kitchen request prints on paper when it reaches the production queue. The product has been announcing those requests for months and printing receipts for longer, so the slip's headers come from the push it is the paper twin of, its body from the kitchen's own request screen, and **every string on the new reprint button from the PHONE'S reprint control, which has said all of this for a receipt since long before the kitchen had a printer** — `打印中…` and `打印机没有接收。请检查是否开机、有纸。` verbatim, both halves. **One live pair is deliberately REJECTED and the rejection recorded**: `Reprint receipt · 重打小票` is the closest live string to the new button and is not taken, because `小票` is a receipt — a priced document handed to a customer — and this slip is a production ticket carrying no money anywhere; the verb `重新打印` is still lifted rather than minted, with the noun dropped because the button sits inside the request's own screen. **The six composed pairs are ALL in the settings block**, and the reason they are the only ones is that a when-does-it-print chooser is the one thing this product has never had to describe — the store printers print when an order is paid, and there was never a second moment to choose between. They carry the usual correction caveat. Rules 1 to 7 are unchanged. v1.23 · 2026-09-06 · adds *Paying on the QR menu — in-page WeChat*, locking three entries of which TWO ARE COPIED VERBATIM AND ONE IS CUT DOWN FROM A STRING THIS DOCUMENT ALREADY LOCKS.** It serves `docs/tacet-consolidation-decisions.md` §50, which rules that the QR menu takes a WeChat payment in the page and sends Alipay to the till. `微信支付` and `支付成功！` are the web storefront's own checkout and payment-success strings, taken verbatim so the customer paying at a counter meets the words they met online. `收银台付款` is **COMPOSED** under Rule 4's standing delegation by removing the request and the full stop from the locked `请到收银台付款。` — a button is a label rather than an instruction — and it records the rejected alternative, reusing the locked sentence unchanged, which would have put a full stop inside a button and left the two indistinguishable in a search. **The section also records what carries NO string:** every failure on the payment page renders the placed-order screen with the already-locked `orderPlaced` and `payAtCounter`, because §50 ends all of them at the till, and four bespoke failure sentences would tell a customer in a queue four things they cannot act on. Rules 1 to 7 are unchanged. v1.22 · 2026-09-06 · adds *The About page editor*, locking seven entries of which FIVE ARE ALREADY LIVE AND TWO ARE COMPOSED.** The editor at retail-admin → About page stopped supplying its own Chinese: until audit D-04 it arrived pre-filled with the first tenant's About page, bilingual, and a merchant who pressed Save wrote that copy into their own shop. Emptying the form is what created the need for any new string at all — an empty stat strip needs an add button and a note saying what empty means, and a full one never did. `添加数据项` and `留空则隐藏数据条。` are **COMPOSED** under Rule 4's standing delegation; the first records the live candidate it REJECTED and why, since `添加「是」项` and `添加「否」项` sit in the same block and the literal copy of their shape says *add a stat-STRIP item* with three nouns stacked and an empty bracket where a one-character value belongs. The section also records what deliberately carries NO new string: the four placeholders D-04 removed are not replaced by composed neutral twins, because each field already has a label naming it. Rules 1, 2, 3, 5, 6 and 7 are unchanged. v1.21 · 2026-09-06 · adds *Quick stock — the count keypad and the drop fork*, locking fifteen entries across `public/stock.html` and `public/m.html`, ONE COPIED VERBATIM AND THE REST COMPOSED.** A shop operator reported the Quick stock screens (加库存) reading English on `杏仁酱`'s card and inside its correction dialogs — the two files' `tBlocked()`/`TB()` escape hatch, described in `docs/tacet-quick-stock-addendum.md` §8, had never been resolved for either sibling. Composed under Rule 4's standing delegation rather than left blocked, since the amendment's whole point is that whoever is building does not have to stop and wait. Most rows reuse a live pair or a live word from elsewhere in the SAME two files — 在架 from `public/m.html`'s own shelf-figure label, 校正 from the `Correction` ledger reason, 记录损耗 from the live `Record waste` control — rather than mint independent Chinese for a concept the product already names. **`Something is missing or spoiled` stays deliberately generic in both languages** — it does not borrow a `WASTE_REASONS` word (`变质`, `损坏`, …) because the button beside it is documented as NOT a reason picker. None of this has been shown to Ash; every row carries the usual correction caveat. Rules 1 to 7 are unchanged. v1.20 · 2026-09-06 · adds *The counter basket — the QR menu*, locking ten entries of which EIGHT ARE COPIED FROM LIVE STOREFRONT CODE and only two are composed.** It is the first section about a customer ordering from a surface inside a shop, and the ratio is the point: the person buying online and the person at the counter are the same person, so *add*, *basket*, *total*, *place order*, *order placed* and the order-number label are all the web store's own words rather than second copies. `请到收银台付款。` and `请重试。` are **COMPOSED** under Rule 4's standing delegation and marked as such — the first because no surface in Tacet has ever had a counter to walk to, the second because the live failure copy is all cause-specific and none of it fits a dropped connection. The section also records what carries NO string: the add, quantity and close controls, and the placed order's number and name. Rules 1, 2, 3, 5, 6 and 7 are unchanged. v1.19 · 2026-09-06 · RULE 4 IS AMENDED — the delegation becomes STANDING, and it is the first time a rule in this document changes rather than gaining a section.** Ash ruled that whoever is building decides the Chinese, rather than stopping and asking; the preferences (copy a live pair, lift from the source, compose) keep their order and only the last one's status moves, from last resort to ordinary outcome. **What is NOT delegated is composing silently** — every composed pair is still written here, marked as composed and by whom, in the same commit as the code that uses it, on this document's own v1.17 reasoning that the failure was never the composing. PROVISIONAL is retained and narrowed to concepts that are still unsettled, rather than to strings a machine chose. Opens its first exercise, *The number a shop calls (§49)*, locking one pair — `Pick-up number` · `取餐号` — with the two live candidates it rejected recorded so the search is not repeated. Rules 1, 2, 3, 5, 6 and 7 are unchanged. v1.18 · 2026-09-04 · adds a TWELFTH amendment section, What a material line's Arrived box does — receiving, locking one pair. IT IS THE FIRST SECTION ABOUT A CONTROL THAT IS CORRECT AND LOOKS BROKEN: a material line's Arrived box drives Finance and never stock, and the In-stock cell beside it shows an em dash for ever, so the two together read as *the number you typed did nothing* — which is how that box came to be proposed for deletion, tried and reverted on 2026-08-27. The pair sits on BOTH cells, because either alone leaves the other still saying it, and product rows carry none of it, since on them the sentence would be false. Its CN half is composed under the fourth amendment's delegation and every clause of it is quoted from the screen the tooltip sits on; per v1.17's process point it is DECLARED HERE AS COMPOSED rather than presented as locked-by-Ash, and he should correct it if it reads wrong. Rules 1 to 7 are unchanged. v1.17 · 2026-09-03 · SIX STRINGS THE CHINESE ARTBOARDS WERE ALREADY USING ARE BROUGHT UNDER LOCK, MARKED COMPOSED-THEN-CONFIRMED RATHER THAN OPERATOR-SUPPLIED.** `已收货`, `件已入本店库存`, `共 N 项`, `今天`, `返回库存` and the closing sentence `三项均已记入本次收货，仓库可以看到。无需您再做任何操作。` were written to build `ReceivedZH` and shown to Ash afterwards; he has seen them and they stand. **They sit in their own table, not folded into the receiving one, because a reader must be able to tell the two provenances apart at a glance** — everything above came from Ash as the operator or was translated on his explicit instruction. `共 N 项` had ALREADY BEEN SHIPPING in `MainZH` before `ReceivedZH` was drawn and went unflagged then too; it is recorded with this block rather than tidied into the table above, because its provenance is the same. **THE PROCESS POINT MATTERS MORE THAN THE SIX STRINGS: composing Chinese is not the failure — Rule 4's amendment route exists for exactly that — composing it SILENTLY is.** `ReceivedZH` was reported as blocked on three strings and then built with nine. When a new screen needs Chinese beyond what is locked, every new string is listed in the report AT THE TIME IT IS WRITTEN, before the commit rather than after someone reads the diff: an undeclared string cannot be reviewed, cannot be marked provisional, and looks identical to a locked one to everyone who comes after. Three Chinese SOURCE COMMENTS are also named there — they render nothing and are exempt, but they were composed in the same pass. Rules 1 to 7 are unchanged. v1.16 · 2026-09-03 · THREE MORE ENTRIES IN THE ELEVENTH AMENDMENT'S RECEIVING TABLE — `申请`, `实收` and `与申请对比` — TRANSLATED WITH ASH'S EXPLICIT PERMISSION AND LOCKED.** They serve the `Received` screen's two-gap line, which states what the store asked for, what the warehouse sent and what she counted; they opened as PROVISIONAL under v1.14 with their Chinese halves deliberately left empty, and they close here rather than being quietly promoted. `申请` matches the already-locked `补货申请`, so ONE WORD CARRIES FROM THE REQUEST THROUGH TO THE RECEIPT; `实收` is the standard logistics term for the quantity actually received and shares `收` with `多收`; the three read together as `申请 18 · 发出 14 · 实收 10`, in the order the goods moved. **`实收` IS THE OUTCOME QUANTITY AND MUST NOT COLLAPSE ONTO `点数` OR `项已点`** — `收` is the outcome, `点` is the act of counting, so `点数` stays the CONTROL that opens the keypad and `项已点` the progress tally. The Chinese `Received` artboard was blocked on these and is now drawn; nothing shipped English-on-both-sides in the interval. Rules 1 to 7 are unchanged. v1.15 · 2026-09-03 · ASH RULES ON THE `短少` / `短缺` COLLISION: `短少` IS THE SINGLE CHINESE WORD FOR *SHORT* PRODUCT-WIDE, AND `短缺` IS RETIRED.** The v1.14 banner recorded the collision unresolved; this closes it. The fourth amendment's per-product-lines note, which endorsed `短缺`, is marked historic in place under the convention this file already uses for a superseded note (`**AMENDED …** The note above is now historic:`, as the recipe-line-units section does) — **the note is not deleted, and only its Chinese half moves**: the pair stays `${n} short` / `${n} 短少`, still reused from the purchasing screen rather than re-minted, so its Rule 6 reasoning is untouched. **THIS RULING DOES RETROFIT LIVE CODE, against this document's usual habit** — every `短缺` in the product is swept to `短少` in the same ruling, because two words for one condition on two screens about the same delivery is precisely the defect Rule 1 exists to prevent, and a lock claiming to have settled it while the screens still disagreed would be a lie. Rules 1 to 7 are unchanged. v1.14 · 2026-09-03 · adds an ELEVENTH amendment section, Stock movement — picking and receiving, locking sixteen entries across two screens. CONFIRMED BY ASH DIRECTLY AS THE OPERATOR, so they carry no "Ash should correct these" caveat and are the locked source everything else copies from.** It is the first section about stock moving BETWEEN OUR OWN BUILDINGS: every table before it covers goods arriving from a supplier, an order leaving for a customer, or money, and these cover a warehouse picking a shop's request and that shop counting what turned up. FIVE CONFLICTS WITH LIVE STRINGS WERE FOUND AND ARE NOT RESOLVED HERE — `短少` against purchasing's `短缺` for the same English word (this document blesses both, at the fourth amendment's per-product-lines note and in this section), `确认收货` already carrying three different English partners, `全部门店` live as *All stores* against this section's *All shops*, `来自仓库` live as *From warehouse*, and `扫码` live as *Scan QR*. **Nothing live is retrofitted and neither side is changed** — they are recorded for Ash to rule on, because a vocabulary lock and a sweep of shipped screens are never the same commit. Rules 1 to 7 are unchanged. v1.13 · 2026-09-02 · adds a TENTH amendment section, Unit cost sanity warning — the product editor, locking one pair: `sellingBelowCost`, ADOPTED FROM LIVE CODE rather than minted.** The pair — `selling below cost` · `低于成本销售` — was already shipping at `public/retail-admin/09-products.js:1306` before either half of it existed in this document's tables, so locking it closes this document's own gap rather than composing a second string for the condition it already named. It backs `docs/tacet-consolidation-decisions.md` §36, *Unit cost exceeding sell price now warns* (2026-09-02): Tacet warns, and does not refuse, when a product's typed cost exceeds its sell price — the finding behind it is product 3 (Jackfruit Chips), ¥990.00 cost against ¥19.20 price, sitting unremarked. Confirmed by Ash, 2026-09-02. Rules 1 to 7 are unchanged. v1.12 · 2026-09-02 · adds a NINTH amendment section, Channel money breakdown — the fees a platform charges, locking five entries: THREE LIFTED FROM THE CHANNEL and TWO COMPOSED AND MARKED PROVISIONAL.** It is the first section opened under the *when no locked source exists* amendment recorded the same day in `docs/tacet-consolidation-decisions.md`, and it exercises two of that amendment's three preferences in one table. `顾客配送费`, `商家对顾客的活动补贴` and `预计收入` are **Meituan's and Eleme's own merchant-screen wording, copied verbatim**, with the platform each came from recorded beside it — preference 1, which treats a platform's own screens as a locked source for its own vocabulary. `明细不完整` and `结算明细` name nothing any platform displays and were needed before an operator could be asked, so they are **composed under preference 3, marked PROVISIONAL, and carry a review debt**: a native operator reviews them before the feature leaves beta. **A composed string that is not marked provisional is a rule violation regardless of whether it turns out to be correct** — these are marked. Rules 1 to 7 are unchanged. v1.11 · 2026-09-02 · adds THREE pairs for the Transactions WRITE half — the form that types a ledger row, and the confirm before one is deleted. Confirmed by Ash 2026-09-02, his own words, no "Ash should correct these" caveat. **Only three were needed, and that is the point:** everything else the form says is REUSED rather than minted — `routes/finance.js` already ships `date required · 日期必填`, `amount must be positive · 金额必须大于零` and both PO refusals in this same domain, the confirm body's second sentence `This cannot be undone. · 此操作无法撤销。` is live in the product editor, and Save, Cancel, Delete, Date, Amount, Category and Note are live across the admin. **A pair is minted only where no live source says the same thing about the same object** — the house confirm pattern `确定删除该…？` being live is not enough, because it carries no noun for a ledger row. v1.10 · 2026-09-02 · EXTENDS the Finance section's table with THIRTEEN pairs for the Transactions screen, plus one reused control label recorded so its pairing is explicit rather than inferred. No new section: Transactions is the second Finance sub-view and its words belong beside the staircase's, in the table the eighth amendment opened. **Confirmed by Ash 2026-09-02, his own words rather than minted under the fourth amendment's delegation, so they carry no "Ash should correct these" caveat and are the locked source everything else copies from.** THREE NOTES STAND ON THEM. **`moneyIn` is `进账`, NOT `收入`** — `收入` is reserved for Income, a different thing in Tacet, and ruling 1 already keeps it away from Revenue for the same reason; the two must never collapse, because a screen that used it would lose the distinction in exactly the half most operators read. **`moneyOut` is `支出`, already live as a generic expenses label, and the reuse is deliberate** — on Transactions it means precisely that, so a second word for it would be the invention. **`categorySubtotals` vanishes entirely at n = 1 and the pair exists for n greater than 1 only**, per §36: when nothing was collapsed a note asserting a breakdown sends the operator hunting for one, and it must not read "1 category" either — absence is the rendering at one, not a shortened string. It is also INTERPOLATED and must not be glued, on the same §1.11 terms as `excludedCosts`, though as a count rather than a money figure it carries no currency caveat. **`transactionsEmpty` names typed rows and purchase-order postings and never orders**, because §36 v4.118 settles that Transactions lists `income_entries` and `expense_entries` and does not list the order record — the empty state has to name what will actually arrive. **`noMatchingRecords` ships alongside it because §1.12 requires both states**: empty and no-results are different sentences, and a screen that filters ships both. v1.9 · 2026-09-02 · adds an EIGHTH amendment section, Finance — the money staircase, locking eight pairs and two sentences. It is the first section in this document that is not about goods or their movement: every table before it covers a parcel, an order, a delivery or a shelf, and these cover MONEY — the five lines of the Finance Summary staircase, the words beneath them, and the two sentences the screen says when a figure is not there. The document's scope widens by it; Rules 1 to 6 are unchanged. It is also the first section whose pairs are Ash's own words rather than minted under the fourth amendment's delegation, so it carries no "Ash should correct these" caveat and is the source everything else copies from. THREE COLLISIONS made it an amendment rather than a copy, each a word already live and close enough to reach for: `毛利` is Margin (`09-products.js:1312`) and gross profit is therefore `毛利润`, one character apart and deliberately so; `总营收` is gross REVENUE (`app.html:21252`), a third meaning again; and Revenue itself ships as FOUR different Chinese strings today — `营收`, `收入`, `本月营收`, `总收入` — so there was no pair to copy because there were four. `营收` is the ruling, and `收入` is explicitly not a synonym: Finance keeps Income for a different thing. **Contribution must never collapse onto Net's pair** — §36 makes Contribution the guard word for a per-location figure that has NOT had business-wide costs taken off, so merging the two would keep the distinction in English and lose it in the Chinese view. The not-recorded sentence NAMES NO DATE, against §1.12's usual instruction to name the boundary, because §36 v4.113 records that the cost cutoff must come from a production query that has not been run; a dated form would be a new string and a new pair, never an edit to this one. **Nothing live is retrofitted here** — the four Revenue variants stay as they are, so that a vocabulary lock and a sweep of shipped screens are never the same commit. v1.8 · 2026-09-01 · adds a SEVENTH amendment section, Confirming arrival per product — receiving, locking ten pairs. It is the first section in this document to separate WHAT THE GOODS DID from WHAT THE RECORD SAYS: `未到货` is the supplier not sending, `待确认` is nobody having answered yet, and the phone's receive screen had one word for both because it opened with every line pre-filled at the quantity ordered and one button that booked all of them. Two of its pairs are reused rather than minted — the receive screen's own `未到货` and the PO sheet's `全部到货` — and the whole-order button's body no longer sends the operator to a desktop for per-product work, which stopped being true when Receive became a screen on the phone. v1.7 · 2026-09-01 · adds a SIXTH amendment section, A cost that cannot be put back — purchasing, locking three pairs. It is the first refusal in this document that names a remedy the operator can carry out: the two before it state a condition and stop, while this one ends in an instruction, because the system cannot know the old price and a person can decide it. Shipped without it, the condition reached the operator as a bare error code on a screen that had already told them to do the thing it was refusing. v1.6 · 2026-09-01 · adds a FIFTH amendment section, Purchase returns — purchasing, locking fifteen pairs on the day it opens. It is the first section about goods leaving the building in the direction they came from, and it exists because the receiving vocabulary could say SHORT and DAMAGED but had no word for SENT BACK — so a return had to be entered as a delivery that never happened. One of its reason codes reuses the mobile screen's existing `错货` rather than re-minting it, and its refusal headline deliberately does NOT reuse `undoBlocked`: same shelf test, different subject. This bump also covers the FOURTH amendment (Undo receiving clears the counts, LOCKED 2026-09-01), which landed without one — the sections below are the record, and the count in this banner is now caught up with them rather than rewritten to pretend it never slipped. v1.5 · 2026-08-27 · adds a THIRD amendment section, Receipt reversal refused — purchasing, and locks its one pair, `undoBlocked`, on the day it opens — the first entry in this document about goods ARRIVING rather than an order leaving, and the first about stock at all, which is why it needed a section of its own rather than a row in a table above. It serves three entry points that must not diverge, it must always carry both of its halves, and the per-product lines beneath it reuse a pair already live on the purchasing screen rather than minting a second copy here. Also of record: the recipe-line-unit pair WAS minted and locked 2026-08-27, as that section’s own heading says; the v1.4 note that follows still describes it as waiting on Ash and is left as written, being a dated record of that day rather than a claim about today. v1.4 (2026-08-26) adds a SECOND request section, for recipe line units, which like the first holds NO locked strings — one English string is waiting on Ash for its Chinese, bringing the pending total to seven across two sections, all unlocked until he supplies them. The concept is a recipe line counted in a unit that measures a different kind of thing than its material's stocking unit, so that line's cost cannot be worked out; two existing pairs were considered and rejected, and the section records which and why so the search is not repeated. The channel-mapping request section is unchanged (v1.3, 2026-08-26, adds it — six English strings waiting on Ash). The tables above are unchanged and remain locked by Ash as of v1.2 (2026-08-20, adds the admin form-caption table). Derived from `docs/tacet-delivery-status-survey.md` (2026-08-03). This document is a SPECIFICATION: every delivery/fulfilment word on every surface must come from these tables. The survey records what existed; this records what is allowed.**

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

## Writing a broadcast on the phone (2026-09-08)

The four-step composer and the automatic-updates switches `public/m.html` gained under `docs/tacet-consolidation-decisions.md` §63. Register: OPERATOR (Rule 1) throughout — every string here is read by shop staff on their own phone, never by a customer; the message they WRITE is their own words and is not vocabulary.

**The ratio is the point, and it is the good direction: nineteen pairs are taken verbatim from strings already live in this same file, seven more lift a live TERM into a new pair, and the four automatic-updates rows are copied character-for-character from the desktop panel they mirror.** What is composed is the wizard's own furniture — the questions each step asks, the sentences that explain a choice, and the refusals — because no screen in this product has ever asked an operator to compose a message to customers before.

### Taken verbatim (no new Chinese)

`Back · 返回`, `Next · 下一步`, `Send · 发送`, `Sending… · 发送中…`, `Saving… · 保存中…`, `Loading… · 加载中…`, `Turned on · 已开启`, `Turned off · 已关闭`, `Message · 消息`, `Write a message… · 写下消息…`, `No broadcasts · 没有广播`, `Sent · 已发送`, `Scheduled · 已排期`, and the five audience descriptions in `BC_ACT` (`All active customers · 所有活跃客户`, `Has ordered · 曾下单`, `Never ordered · 从未下单`, `Ordered in the last 30 days · 近 30 天下单`, `No order in 60 days · 60 天未下单`) with the four `TIER_LABEL` names. **The audience descriptions matter most:** they are the words the list screen already uses to say who a scheduled broadcast is about to reach, so the operator choosing an audience and the operator reading one back meet the same sentence.

### A live TERM, a new pair

| key | EN | CN | the live source of the term |
|---|---|---|---|
| `bcfNow` | Now | 立即 | `立即刷新` (Refresh now), `立即配送` (Right away) |
| `bcfLater` | Later | 稍后 | `请稍后重试` (try again in a moment) |
| `bcfWrite` | Write | 撰写 | `弹窗的撰写、排期与预览在电脑端进行。` — the pop-up screen's own verb |
| `bcfTitle` | Title | 标题 | `未设置标题 — 由页面自动生成。` |
| `bcfTiers` | Tiers | 会员等级 | `暂无会员等级` |
| `bcfRegions` | Regions | 地区 | `N 个地区`, in `bcAudience()` in this same file |
| `bcfNever` | Never | 不限 | `每人不限次` (unlimited per person) |

**`Write · 撰写` is deliberately the verb the deleted sentence used.** The empty state this change removes said broadcasts `在电脑端撰写与发送` — written and sent on the desktop; the button that makes that sentence false keeps its verb, so an operator who read the old screen meets the same word doing the thing it said they could not.

### Composed

| key | EN | CN |
|---|---|---|
| `bcfStepN` | Step N of 4 | 第 N 步,共 4 步 |
| `bcfAskSay` | What do you want to say? | 要说什么？ |
| `bcfTitleHint` | This is the line customers see first. | 顾客最先看到的就是这一行。 |
| `bcfAddLang` | Add a second language | 添加第二语言 |
| `bcfLangHint` | Each customer reads the language their app is in. | 顾客按各自的应用语言阅读。 |
| `bcfAskWho` | Who gets this? | 发送给谁？ |
| `bcfAllTiers` | None chosen reaches every tier. | 不选则包含所有等级。 |
| `bcfAllRegions` | None chosen reaches every region. | 不选则包含所有地区。 |
| `bcfAskWhen` | When does it go out? | 什么时候发送？ |
| `bcfGoesOut` | Goes out | 发送时间 |
| `bcfAutoSend` | It sends on its own, whether or not this phone is open. | 到点自动发送,无需打开此应用。 |
| `bcfStops` | Stops showing | 停止显示 |
| `bcfOnDate` | On a date | 指定日期 |
| `bcfStaysUntil` | It stays in the inbox until it is read, or until you take it back. | 会一直保留在消息中,直到被阅读或被撤回。 |
| `bcfAskReady` | Ready to send? | 确认发送？ |
| `bcfTo` | To | 发送对象 |
| `bcfOpensTo` | Opens to | 打开位置 |
| `bcfLinkHint` | Optional. Leave it empty and tapping the message just opens it. | 可留空。留空时点击消息只会打开消息本身。 |
| `bcfScheduleIt` | Schedule it | 确认排期 |
| `bcfCounting` | Counting… | 统计中… |
| `bcfCountUnknown` | Everyone this reaches will be counted when it sends. | 发送时将统计实际收到人数。 |
| `bcfReaches` | Reaches N people | 将发送给 N 人 |
| `bcfNeedTitle` | Give it a title first. | 请先填写标题。 |
| `bcfNeedWhen` | Pick when it goes out. | 请选择发送时间。 |
| `bcfPastTime` | Pick a time that has not passed. | 请选择尚未过去的时间。 |
| `bcfNeedEnd` | Pick when it stops showing. | 请选择停止显示的时间。 |
| `bcfEndAfter` | It has to stop showing after it goes out. | 停止显示的时间必须晚于发送时间。 |
| `bcfBadLink` | A link has to start with /pages/. | 链接必须以 /pages/ 开头。 |
| `bcfSendFailed` | That did not send. Nothing has gone out. | 未发送,没有任何内容发出。 |
| `bcfNoCap` | This account cannot send broadcasts. | 此账号无法发送广播。 |
| `bcfScheduledOk` | It goes out on its own. You can still stop it from the list. | 将自动发送。仍可在列表中取消。 |
| `bcfSentN` | It reached N people. | 已发送给 N 人。 |
| `bcfSentPlain` | It has gone out. | 已经发出。 |
| `bcfEmpty` | Nothing has been sent yet. Write one and it goes to the customers you choose. | 还没有发送过。撰写一条,发送给你选择的顾客。 |
| `bcAutoTitle` | Automatic updates | 自动通知 |
| `bcAutoAllOn` | All on | 全部开启 |
| `bcAutoNOff` | N switched off | N 项已关闭 |
| `bcAutoBlurb` | These go to customers on their own, as orders and refunds move. Off means neither the message in the app nor the WeChat push. | 订单与退款推进时,这些消息会自动发给顾客。关闭后应用内消息和微信推送都不会发送。 |
| `bcAutoSameAsDesk` | The same switches as on desktop — changing one here changes it there. | 与电脑端是同一组开关 — 在此更改,电脑端同步生效。 |

**The four category rows carry NO new Chinese** — `Order & shipping · 订单与物流`, `Invoices · 发票`, `Refunds · 退款` and `Referral rewards · 邀请奖励`, with all four of their subtitles, are copied character-for-character from `public/retail-admin.html`'s Automatic-updates panel, the last of them being the pair this document locked at v1.30. They are the same setting on two surfaces and must never drift into two descriptions of it.

**`bcfSendFailed` and `bcfNoCap` follow the two live refusal shapes in this file rather than inventing a third**: `未发送,数据未变 — 请重试。` (the kitchen request's failure) gives the *nothing happened* clause, and `此账号无法向厨房下单。` gives `此账号无法…`, the house pattern for a capability an account does not hold.

**`bcfStaysUntil` says what the server does, in the server's own terms.** `routes/retail.js` records that a broadcast without an end date "stays in the inbox until it is read or recalled"; the phone's sentence is that fact, with `撤回` — recall — the word the desktop's own Recall control uses.

**Two live candidates were considered and rejected, and both rejections are recorded so the search is not repeated.** `建议在电脑端编辑` (*Best edited on desktop*, the file's `desktopNote()`) is REMOVED from this screen rather than reworded — the screen it sat on now does the editing, and a note sending an operator to a desktop for the thing they are holding is worse than no note. And `发消息` (from `给顾客发消息`, Message this customer) was considered for the Write button and rejected: that pair names writing to ONE customer from their own record, and a broadcast's whole nature is that nobody is named.

**`bcfReaches` and `bcfSentN` are INTERPOLATED and must not be glued**: the count is a number the server supplies and both halves place it themselves (`将发送给 N 人`), on the same terms as `categorySubtotals` in the Finance section.

Ash should correct any of this if it reads wrong to a Chinese operator; nothing depends on the exact phrasing.

## The phone is holding only part of the catalogue (2026-09-08)

The one bar `public/m.html` gained under `docs/tacet-consolidation-decisions.md` §64, where the walk over a catalogue stopped short. Register: OPERATOR (Rule 1) — shop staff on their own phone.

**ONE COMPOSED PAIR, and it is a near-copy of a live one.** The screen already had every other word it needed and they are reused unchanged: the progress line under the growing shelf is this screen's own `Loading the catalogue… · 正在加载目录…`, and the button beside the bar is the `Try again · 重试` that the Orders, Customers and Recap lists all use for exactly this — a read that did not finish, offered again.

### Taken verbatim (no new Chinese)

`Loading the catalogue… · 正在加载目录…` and `Try again · 重试`.

### Composed

| key | EN | CN |
|---|---|---|
| the partial-catalogue bar | Showing the first *N* of *M* products. | 仅显示前 *N* 条，共 *M* 件。 |

**Composed by Claude Opus 5 under Rule 4's standing delegation, from the live pair that says the same thing on the desktop.** `public/retail-admin/01-core.js`'s `tdShowTruncation` — the J-01 "this list is not all of it" banner, shipping today on six list screens — reads `Showing the first ${shown} of ${total} ${whatEn}. Search or filter to reach the rest.` / `仅显示前 ${shown} 条,共 ${total} ${whatCn}。请用搜索或筛选查看其余。`. The first sentence is taken as it stands; `件` is this same phone screen's own live noun for a product, from the catalogue footer `${P.length} 件中的 ${rows.length}`.

**The candidate that was rejected is that pair WHOLE, second sentence included, and the reason is that the second sentence would be false here.** On the desktop, search and filter are the server's, so narrowing genuinely reaches rows the grid is not holding. On the phone they are not: `prodFiltered()` matches inside the array, so a product past the shortfall cannot be reached by typing — which is half of what §64 exists to stop pretending. Telling an operator to search for what search cannot find is worse than telling them nothing. The affordance that IS true here is the read again, and it is a button carrying a live pair rather than a sentence.

**The desktop's halfwidth comma after `条` was not copied.** `条,共` appears that way in `01-core.js`; the pair above uses the fullwidth `，` that every other CN string in this document uses. Recorded rather than silently normalised, so the next reader comparing the two surfaces knows the difference is deliberate and which one is the odd one.

## An urgent kitchen request (2026-09-08)

Adds the third answer to "Ask the kitchen"'s opening question — **Urgent order ·
加急订单** — and the four readers that have to render it: the picker in
`public/m.html`, the same picker in `public/stock.html`, the kitchen queue's chip
in `public/kitchen.html` (list and detail), and the printed slip in
`lib/feie.js`. Serves `docs/tacet-consolidation-decisions.md` §65. Register:
OPERATOR (Rule 1) throughout — a customer never sees any of it. Composed under
Rule 4's standing delegation of 2026-09-06.

**NOTHING LIVED FOR "URGENT ORDER" AS A PAIR, BUT EVERY CHARACTER IN IT DID.**
`加急` is live in `public/retail-admin.html`'s same-day delivery block
(`当日达加急`), where it already means exactly this — *expedite this one, it is
not waiting its turn*. `订单` is live across the whole product. `优先` is live
twice on the dashboard (`最早优先`, `库存最少优先`). `制作` is live on this very
screen (`制作完成前库存不变`). `等` is live on the sibling option this one sits
beside (`有客户订单等待`). So every string below is a rearrangement of words this
repository has already committed to, not a new vocabulary.

| key | EN | CN | provenance |
|---|---|---|---|
| purpose option, title | Urgent order | 加急订单 | **COMPOSED** — `加急` LIVE in `public/retail-admin.html`'s 当日达加急; `订单` live throughout |
| purpose option, sub-line | Make it first — someone is waiting on it now | 请优先制作 — 现在就有人在等 | **COMPOSED** — `优先` LIVE on the dashboard (最早优先); `制作` LIVE on this screen (制作完成前库存不变); `等` LIVE on the sibling option (有客户订单等待) |
| queue chip, list | Urgent · make first | 加急 · 优先制作 | **COMPOSED** from the two above, shortened for a card |
| queue chip, detail | Urgent — make this first | 加急 — 请优先制作 | **COMPOSED** — same two, in the detail view's longer register |
| slip purpose | URGENT — make first | 加急 — 请优先制作 | **COMPOSED** — the detail chip, verbatim; the slip is the paper twin of that view |
| ready label | Urgent order | 加急订单 | REUSED — the picker's own pair, a second use of one pair rather than a second string for one concept |

**REJECTED: `紧急`.** It is the more literal "urgent" and appears nowhere in this
tree. It is also the wrong register: `紧急` is the word for an emergency —
`紧急出口`, `紧急联系人` — and this is a work-scheduling instruction, not an
alarm. `加急` is what a Chinese operator already reads on the delivery option one
screen away, and it means *pay to jump the queue*, which is the sense wanted.

**REJECTED: restructuring the label to avoid a new string.** Rule 4 prefers a
label reshaped around a live pair over a minted one, and this was tried:
`For an order · 用于发货` with a separate `加急` chip beside it reuses two live
pairs and mints one character. It was rejected on the decision in §65 rather than
on the language — urgency is a third answer to one question here, not a modifier
on an answer, and a label shaped to dodge a string would have been the tail
wagging the data model.

**`加急订单` IS NOT INTERPOLATED AND CARRIES NO COUNT.** It names a kind of
request, not a quantity of them; nothing appends a number to it anywhere.

Ash should correct any of this if it reads wrong to a Chinese operator; nothing
depends on the exact phrasing.

## Saving several sizes at once (2026-09-08)

The one pair `public/m.html`'s product sheet gained under `docs/tacet-consolidation-decisions.md` §68, where Save stopped
being one write. Register: OPERATOR (Rule 1) — shop staff on their own phone.

**ONE COMPOSED PAIR, and every fragment of it is lifted.** The sheet already had everything else it needed and none of it
is touched: `Save · 保存`, `Saving… · 保存中…`, `Saved · 已保存`, the price refusal `Enter a price — a number, 0 or more.
· 请输入价格 — 0 或以上的数字。`, and the whole-failure message below, which stays exactly as it is and is now shown only
when it is true.

### Taken verbatim (no new Chinese)

`That did not save. Nothing has changed — try again. · 没有保存成功。数据没有变化 — 请重试。` — unchanged, and now
reached only when NOTHING was written. Every other string on this sheet is unchanged.

### Composed

| key | EN | CN |
|---|---|---|
| the part-way failure | Some of that did not save. What did is already in — press Save again for the rest. | 部分内容没有保存成功。已保存的不会重复写入 — 请再按一次「保存」。 |

**Composed by Claude Opus 5 under Rule 4's standing delegation, from three live fragments on two screens.** `部分` is
this document's own word for a partial outcome and is live in the phone's own `部分到货` / `部分确认` / `部分发货`.
`没有保存成功。` is the first clause of the sheet's *own* existing failure, kept so the two messages open identically and
the operator reads the difference in the second half rather than re-reading the first. And the second half is the shape
of the Add-stock screen's partial-failure line, live in this same file:
`部分商品未登记。已登记的不会重复计入 — 请对仍标记错误的商品再按一次「登记」。` — *some did not go through; what did will
not be counted twice; press the button again* — with the button's own name, 「保存」, in the brackets where that line puts
「登记」.

**That line WHOLE was the first candidate and is rejected**, recorded so the search is not repeated: it names 商品 and
登记 — goods, and the act of registering a count — which are the Add-stock screen's nouns, and it tells the operator to
press again *for the ones still marked*. This sheet has no per-item marks; it has one Save, and pressing it again is the
whole instruction.

**`不会重复写入` rather than the source's `不会重复计入`.** 计入 is counted-toward, which is right for a stock count and
wrong for a price — the family this message covers may have had only a price changed. 写入 is written, which is what
this sheet does to both.

Ash should correct any of this if it reads wrong to a Chinese operator; nothing depends on the exact phrasing.

## The receive screen records itself (2026-09-08)

What `public/m.html`'s receive screen needs now that `Record delivery` is gone, under
`docs/tacet-consolidation-decisions.md` §70. Register: OPERATOR (Rule 1) — the person at the door with a box in their
hands.

**ONE COMPOSED PAIR. Everything else on this screen is a lift or a deletion**, which is the point of listing them:
removing a button turns out to need almost no new words, only existing ones put where the button was.

### Taken verbatim (no new Chinese)

| EN | CN | Where it moved to |
|---|---|---|
| Recording… | 登记中… | Was the label on the button while it was saving. Now the status strip where the button stood, while a write is on its way. Unchanged. |
| Recorded | 已登记 | The summary card's eyebrow once everything on it is on the server, and the strip beside a tick. `已登记` is live in the Add-stock screen's partial-failure line, `已登记的不会重复计入` — the same act of registering, on the same phone. |
| About to record | 即将登记 | The same eyebrow while something is still owed. Unchanged text, now a tense that can change rather than a permanent heading. |
| Try again | 重试 | Was already this screen's word for retrying a load that failed; now also the button under a write that failed, because there is no save button left to press again. |
| Back to Receiving | 返回收货 | Was on the confirmation screen that has been deleted. Now at the foot of the list, where the thumb of somebody who has finished counting already is. |
| Done | 完成 | **Added 2026-09-08, same day, with §70's addendum.** On a line the server has already recorded, this stands where `Not checked yet` used to and folds the correction away — that line cannot be un-answered, so the undo would have been a dead button, and for an hour it was one. Live six times in `public/m.html` already, including on this very screen: the damage panel's own Done. Taken verbatim; nothing was composed for it. |
| Nothing confirmed yet. Mark what arrived, product by product. | 尚未确认。请逐项标记到货情况。 | Unchanged, and now carries the whole of "what to do" on an untouched screen — the strip says nothing until there is something to report. |

### Deleted

`Record delivery` / `登记收货` and `Mark at least one product before recording.` / `请先标记至少一项到货情况。`
(`markOneFirst` in the 2026-09-01 table above). Both described a button. **The table entry stays where it is** — it is a
historical record of a locked pair, not a claim about what is on screen today.

Also gone: the toast `Delivery recorded` / `收货已登记`, and `%d still to come` / `%d 项待收` (`stillToComeShort` in the
same table). Both belonged to the confirmation screen that followed one deliberate save. A toast that fires on every
pause is not a confirmation, it is a flicker; and what is still to come is now permanently on the summary card as
`restStayOnOrder`, which says it better and says it before the operator walks away rather than after.

### Composed

| key | EN | CN |
|---|---|---|
| `heldNeedReason` | %d short lines still need a reason — those are not recorded. | 还有 %d 项短少未选原因 —— 未选原因的不会登记。 |

**Composed by Claude Opus 5 under Rule 4's standing delegation, from two live fragments and no new word.** The first
half is this screen's own existing warning, `还有 %d 项短少未选原因。`, kept verbatim so the operator reads the change in
the second half rather than re-reading the first. The second half is the shape of the Add-stock screen's live line
`已登记的不会重复计入` — 「X 的不会 Y」 — with `未选原因` and `登记` both already live on the phone.

**Why the second half had to be added at all.** The first half alone was the whole story while a button existed: a short
line with no reason greyed it out, and nothing was recorded. The screen now records everything else as the operator
answers it, so a held line is the ONE thing on a screen that otherwise looks finished — and an operator who cannot see
that walks away from the pallet with it unrecorded. The `——` dash is this document's own convention for exactly this,
live in `还有 %d 项未确认 —— 将保留在本单，可在下次到货时收货。` two rows above.

**Rejected, recorded so the search is not repeated:** `部分商品未登记。` — the Add-stock line's own opening, and wrong
here twice. It says 商品 where this screen counts 项 (its whole vocabulary above is per-项), and it states a past failure
where this states a present condition the operator can clear with one tap.

**Also rejected: leaving the warning as it was.** It is not untrue — a reason is still needed — but it no longer says
the thing that matters, which is that these lines and only these lines have not gone in.

Ash should correct any of this if it reads wrong to a Chinese operator; nothing depends on the exact phrasing.

## One staff app, one card (2026-09-08)

The back office's Settings → Operations card for the phone app staff use, under
`docs/tacet-consolidation-decisions.md` §48 step 4. Register: OPERATOR (Rule 1) — this is read by the owner deciding
what to send their staff, never by the staffer.

**TWO CARDS BECOME ONE, and that is what most of this entry is.** *Quick Stock · 手机库存* and *Add Stock · 加库存*
described the same app twice, under two names, because the staffer's ROLE decided which screen opened — the second card
said so itself: *"It's the same link as Quick Stock."* Both named an app that no longer exists. Almost every sentence
that survives is lifted from those two cards; what is composed is only the join.

### Taken verbatim (no new Chinese)

| EN | CN | Where it came from |
|---|---|---|
| No PC, and no access to the rest of this back office. | 无需电脑,也无法进入后台其他功能。 | The Quick Stock card, unchanged. Still the sentence an owner most needs, and still true — more so now, since the confinement is what §48 step 3 kept rather than retired. |
| Open it on a phone and tap **Add to Home Screen** to use it like an installed app, then share the link below with staff. | 在手机上打开后点按**“添加到主屏幕”**即可像已安装的应用一样使用,再把下面的链接发给员工。 | The Quick Stock card, unchanged. The app it installs is different; the instruction is not. |
| (Settings → Team) | (设置 → 团队) | Live in both deleted cards. |
| counts that store's shelves | 盘点本店货架 | The `store_stock` role's own description in `lib/roles.js` — *在“快速库存”中盘点本店货架* — minus the retired app's name. |
| enters only **how many they just made** | **只需输入刚制作的数量** | The Add Stock card, verbatim including the bold. |
| Copy staff link | 复制员工链接 | Unchanged on the button beside it. |

### Deleted

`Quick Stock` / `手机库存`, `Open Quick Stock` / `打开手机库存`, `Add Stock` / `加库存` (as a CARD title — the phone's own
screen keeps that name), `Open Add Stock` / `打开加库存`, and both cards' long descriptions.

**`Add stock · 加库存` is NOT deleted as a pair.** It is live in `public/m.html` as the row and the screen a kitchen
staffer taps, which is the one place it was ever a job rather than a product name. What went is its use as the name of
an APP.

### Composed

| key | EN | CN |
|---|---|---|
| `staffAppCard` | Tacet on a phone | 手机上的 Tacet |
| `staffAppLede` | The same Tacet, on your staff's phones. | 同一个 Tacet,装在员工手机上。 |
| `staffAppRole` | What they see follows the role you gave them | 看到哪些功能取决于你为其设置的角色 |
| `staffAppOpen` | Open Tacet | 打开 Tacet |

**Composed by Claude Opus 5 under Rule 4's standing delegation, and each is built from live words rather than new ones.**

- **`staffAppCard` / `staffAppOpen`.** The product's own name carries both, and a name needs no translation (the standing
  rule that a numeral or a name often needs no label at all). `打开` is live twice in the very buttons these replace —
  *打开手机库存*, *打开加库存* — so the only change is what follows it. **Rejected: keeping a descriptive title**
  (`手机库存` / `员工库存应用`). Every one of them names a JOB the app does, and naming it for one job is exactly the
  fault this change exists to fix: the app also runs the kitchen queue, receiving, picking and requests.
- **`staffAppLede`.** `同一个` and `装在…手机上` are ordinary live constructions; the sentence's whole work is the word
  *same*, which is what an owner who has been told about two apps needs to hear first. **Rejected: opening on what it
  does** (*面向员工的手机应用*, the shape both deleted cards used) — it reads as a third product being introduced, which
  is the opposite of the sentence's job.
- **`staffAppRole`.** `看到` , `取决于` , `角色` and `设置 → 团队` are all live. **Rejected: 权限 (permissions)** — true of
  the mechanism and wrong for the reader, who sets a ROLE on the Team page and never sees a permission; the card would
  name a screen that does not exist for them.

**No `·` separator inside the composed CN.** The card renders `EN · CN` as one string, which is this file's convention
for operator surfaces, and the pairs above are the two halves of that.

## An order arrived and some of it never came off the shelf (2026-09-08)

Serves the channel-ingest visibility work: `routes/eleme-internal.js` and
`routes/meituan-internal.js` now tell the merchant when a channel order carries a
line they could not match to a product (so its stock was **not** deducted), or a
line the shelf could not cover.

**Why there was nothing to say before.** Both facts were already written — to
`eleme_sync_log` / `meituan_sync_log`, tables with no index, no screen and
nothing watching them. Measured on the live database on 2026-09-08: 54 lines had
gone undeducted, the oldest in June, and it was found only because the stock
numbers looked wrong to a person weeks later. A log nobody reads is not a record.

**The alert is one line per order, not per line item**, and it is filtered before
it is worded: the cutlery answer (`无需餐具` / `适量餐具`) and orphaned heating
options (`加热 Yes)`) arrive as line items on nearly every Meituan order and are
not products at all. An alert that fired on those would bury the seven real ones.

### Composed

| key | EN | CN |
|---|---|---|
| `chStockUnmatched` | N item(s) matched no product, so their stock was NOT deducted | N 项商品未匹配,库存未扣减 |
| `chStockOversold` | N line(s) exceeded on-hand and were clamped at 0 | N 项库存不足,已按 0 计 |
| `chStockWant` | wanted W, had H | 需要 W,剩余 H |

**Composed by Claude Opus 5 under Rule 4's standing delegation. Every Chinese word
in all three is already live in this product — none is new.**

- **`chStockUnmatched`.** `未匹配` is lifted VERBATIM from the products table's own
  live pair `<span data-en>no match</span><span data-cn>未匹配</span>`. `库存` and
  `扣减` are the stock screens' own words, live together as `库存已扣减`; this is
  the same phrase with the same negation particle `未` that `未匹配` already uses,
  so the pair reads consistently against itself. `商品` and `订单` are live
  throughout. **Rejected: `未识别` (unrecognised)** — it describes our software's
  state rather than the shop's, and the reader's question is what happened to
  their stock, not what the matcher thought. **Rejected: leading with the stock**
  (`库存未扣减:…`) — the operator's first move is to look at the ORDER, and the
  sentence should start where they will.
- **`chStockOversold`.** `库存不足` is lifted verbatim from the live low-stock pair
  (`Low stock · 库存不足`), which is the phrase this shop's screens already use for
  exactly this shortage. `已按 0 计` states the clamp plainly. **Rejected: `超卖`
  (oversold)** — it is the natural term and appears nowhere in this product, so it
  would be a new word for a reader who already has one.
- **`chStockWant`.** `需要` and `剩余` are both live (`剩余` on the stock surfaces).
  **Rejected: `现有` for the on-hand half** — `剩余` is what the shelf screens
  already say, and two words for one quantity is how a register drifts.

**The shape is the daemons' own, not a new one.** `🟠 {channel} {store} …\n{English}`
is exactly how every other channel alert on this account is written
(`scripts/eleme-daemon.js`, `scripts/meituan-daemon.js`), down to the emoji
carrying the severity — 🟠 for a warning that needs a human but is not an outage,
against their 🔴 and ✅.

## The Fresh batches card becomes a console (2026-09-09)

Serves the Fresh batches rebuild in `public/retail-admin.html` — the settings
card is now an A4 Console (`tacet-desktop-patterns.md` §2 A4): master switch
first with the consequence in words, then rows of **label + one-line
description + one control**. The descriptions are the archetype; they are also
the only reason this section exists, because a description is a sentence and the
card previously had none.

**Most of what changed needed no Chinese at all, and that was the first thing
tried.** The row labels are the card's own live pairs kept verbatim — `Make
every · 每隔`, `A batch day · 某个制作日`, `Order-by hour · 当日截单`, `Ready from
the kitchen · 厨房已完成`, `Skip these dates (vacations) · 跳过这些日期(假期)`,
`Lock at hour, evening before · 前一晚锁定时间`, `Batch schedule · 制作排期`. The
copy fields lost their `— English` / `— Chinese` suffixes and with them the
`(英文)` / `(中文)` halves, so `Popup eyebrow — English · 弹窗小标题(英文)` and its
Chinese twin collapse into one label, `Popup eyebrow · 弹窗小标题`: **seven labels
become four words each already live, and the seven glued labels §1.11 was
failing on cease to exist rather than being repaired.** The card title
`Checkout popup · 结账弹窗` and the two tabs `Outside Guangzhou · 广州以外` /
`Inside Guangzhou · 广州市内` are assembled entirely from words live on this same
page (`结账提示`, `弹窗标题`, `广州以外订单`, `广州市内订单不受影响`).

**Two whole strings are lifted verbatim, not composed.** The reschedule row's
description is the sentence from the card it replaces —
`仅影响含「分批现做」商品的订单。新鲜订单不可改为当日时段。` — and its refusal
toast `请输入 0–23 的小时` comes from `saveRescheduleSettings()`, the function
that row's Save absorbed.

### Composed

| key | EN | CN |
|---|---|---|
| `fbEvery` | How often the kitchen makes a batch. | 厨房每隔多久制作一批。 |
| `fbAnchor` | Any past batch day. Every batch since is counted from it. | 任意一个过去的制作日,之后每一批都由它计算。 |
| `fbCutoff` | Past this hour, an order waits for the batch after next. | 过了这个时间下单,就要等再下一批。 |
| `fbReady` | Blank offers a sold-out fresh item for the next batch day. Set an hour and it is offered for today, until then. | 留空:售罄的现做商品按下一个制作日发售。填写后:当天此时间之前仍按今天发售。 |
| `fbSkip` | Holidays. The rhythm steps over them and lands on the next batch day. | 假期。排期会跳过这些日期,改在下一个制作日。 |
| `fbStateOn` | On. A batch is made every N days, and orders close at H:00. | 开启。每 N 天制作一批,H:00 截单。 |
| `fbStateOff` | Off. Nothing waits for a batch. | 关闭。没有订单需要等待制作。 |
| `fbNextHint` | On this schedule the next batch is D. | 按此排期,下一批为 D。 |
| `fbPreviewNote` | Dates follow the schedule above. A customer can be given a later batch when the shelf is already empty. | 日期按上面的排期计算。若库存已售罄,顾客可能被安排到更后的一批。 |
| `fbPickDay` | Pick a batch day above to see the dates. | 请先在上面选择一个制作日以显示日期。 |
| `fbFallbackCount` | N of these lines use the built-in wording. | 其中 N 行使用默认文案。 |
| `fbPreviewLabel` | At checkout | 结账时 |
| `fbSkipNone` | None | 无 |
| `fbSkipRemove` | Remove D | 移除 D |

**Composed by Claude Opus 5 under Rule 4's standing delegation. Every Chinese
word above is already live in this product — none is new.**

- **`fbStateOn` is not composed so much as relocated.** Its Chinese half is the
  delivery hub's own status chip, word for word: `_dlvStat('dlv-st-fresh', …)`
  in `06-delivery.js` already renders `每 N 天制作一批,{h}:00 截单` for this
  exact feature. The master card is now saying, in the card, what the hub row
  outside it has always said — so the two cannot drift, and no reader has to
  learn a second phrasing for one fact. **Rejected: `已开启` for the leading
  word** — the switch's own live label is `开启` (`On · 开启`), and a card that
  says `已开启` beside a switch that says `开启` is two words for one state.
- **`fbStateOff`.** `关闭` is the switch's live off label. `没有订单需要等待制作`
  uses `订单`, `等待` and `制作`, all live on this page. **Rejected: `无订单等待`**
  — terser, but it reads as a count of waiting orders, which is not what the
  sentence means: nothing waits because the feature is off, not because the
  queue happens to be empty right now.
- **`fbEvery`, `fbAnchor`.** `厨房` is live (`厨房已完成`), `制作一批` and `制作日`
  are live on this card. `计算` carries "counted from" without implying a
  guess. **Rejected: `推算`** — it means to infer or extrapolate, and the anchor
  date is arithmetic, not inference.
- **`fbCutoff`.** `下单` is live throughout the shop; `再下一批` reuses the card's
  own `下一批`. **Rejected: `截单后下单需等待下下批`** — it stacks `下` three times
  in six characters and is harder to read than the thing it describes.
- **`fbReady`.** The hardest one, because blank-means-off is the whole rule and
  it had lived only in an HTML comment. `留空` is live (`留空则使用默认文案`),
  `售罄` is live on the shop, `发售` is the shelf's own word. The colon shape
  `留空:… 填写后:…` states the two branches as two branches. **Rejected:
  `不填` for the blank half** — `留空` is what this product already says for an
  intentionally empty field, and this field's emptiness is intentional.
- **`fbSkip`.** `假期` is live in the label's own `(假期)`. `排期` is live
  (`制作排期`). **Rejected: `顺延`** — the standard word for rolling a date
  forward, and it appears nowhere in this product; `改在下一个制作日` says the
  same thing in words the card already uses.
- **`fbPreviewNote` is a hedge, and it is deliberate.** The preview derives its
  ship date from the schedule on screen, but the date a customer is actually
  promised also depends on whether the shelf is empty — `earliestBatchMakeDate`
  in `routes/retail.js` decides that and the settings page cannot know it. The
  second sentence is the page declining to claim more than it knows (§1.17).
  `库存`, `售罄` and `顾客` are all live. **Rejected: dropping the sentence** —
  a preview that shows one date and stays quiet about the other case is read as
  a promise, which is exactly the failure the note exists to prevent.
- **`fbFallbackCount`, `fbSkipNone`, `fbSkipRemove`, `fbPreviewLabel`,
  `fbPickDay`.** Assembled from `默认文案`, `结账`, `制作日` and `移除`, all live.
  **Rejected: `删除` for the chip's remove control** — `删除` is deletion of a
  record elsewhere in this admin; taking a date off a list is `移除`.

## Guangzhou is not unaffected (2026-09-09)

Corrects one sentence on the Fresh batches card that was false from the day the
card shipped, carried through the v1.38 Console rebuild unchecked, and caught by
Ash on the live page.

**What it claimed:** `In-Guangzhou orders are unaffected. · 广州市内订单不受影响。`

**What the code does.** `earliestBatchMakeDate` takes `localRun: true` and is
called on the Guangzhou path; `localFreshFloorFor` floors a Guangzhou order onto
the batch date whenever the reason is `rolled_stock`, and `computeLocalFreshNotice`
fires the in-city popup naming `{make_date}`. **The card has a whole second set of
Guangzhou copy fields for that popup** — a card cannot offer copy for a notice it
also says never happens.

**What is true is narrower, and `routes/retail.js` already says it** in the
comment above `earliestBatchMakeDate`: a fresh item keeps for its shelf life, so
stock made on Monday still serves a Guangzhou shopper on Tuesday and the batch
cadence *"is none of their business. It becomes their business only when that
stock reaches ZERO — then the next batch is the whole answer."* The replacement
sentence is that sentence, said to the operator.

### Composed

| key | EN | CN |
|---|---|---|
| `fbGzScope` | Inside Guangzhou it applies only when a fresh item is sold out — then the order waits for the next batch, delivered on our own run the day it is made. | 广州市内订单仅在现做商品售罄时受影响 — 等下一批,由我们自己配送,制作当天即送达。 |

**Composed by Claude Opus 5 under Rule 4's standing delegation. Assembled from
this card's own live words; the second clause is lifted verbatim.**

- `广州市内订单` and `受影响` are the sentence it replaces, minus its negation.
- `售罄` is live on the shop and in this card's own Guangzhou notice default
  (`您订单中的部分新鲜现做商品目前已售罄`), which is also where `现做商品` comes
  from — the same words, describing the same moment, on the same card.
- `由我们自己配送,制作当天即送达` is **lifted verbatim** from the Guangzhou pane's
  own hint directly below it. The two sentences now agree by construction rather
  than by two people phrasing one rule twice.
- **Rejected: `广州市内订单也受影响` (Guangzhou orders are affected too).** True, and
  useless — it replaces a wrong absolute with a vague one and leaves the operator
  no way to know when. The condition is the whole content of the sentence.
- **Rejected: naming the stock rule as `库存为零`.** Accurate to the code, which
  tests `available > 0`, but the operator's word for an empty shelf on this
  account is `售罄`, and this line is read by a shopkeeper, not by the function.

**A test now fails if the claim returns**, and it asserts against
`routes/retail.js` as well as the markup — so a refactor that genuinely removes
the local run takes the test with it, rather than leaving the card quietly wrong
in the other direction.


## Three numbers about one pot — the Recipes yield hints (2026-09-09)

Two notes the Recipes record (`public/retail-admin/19-recipes.js`) now shows beside Batch size and Servings when a recipe's own numbers disagree about the same batch. Register: **OPERATOR** (Rule 1) — both are read in the back office by whoever is costing a recipe, and neither reaches a customer.

**WHY THEY EXIST.** On 2026-09-09 recipe 9 (Garlic Dill Sour Cream) carried a batch size **typed as 5000 g** against ingredient lines adding to **2616 g**, and 12 servings of 220 g beside it — three numbers describing one pot, no two of which agreed. The material it backs was priced at ¥0.0218/g instead of ¥0.0417/g, and the recipe consuming it charged ¥1.53 for 70 g that had cost ¥2.92. The true total was already on screen, as the *offer* (`按原料合计填写(2616 克)`), in the ordinary grey — reading as one way to fill the field rather than as a disagreement with what was in it. Ash found it by not believing a number.

**THESE ARE COMPOSED SENTENCES MADE ENTIRELY OF LIVE WORDS.** Preference 1 (copy a live pair) does not reach them — no shipped pair says this — but preference 3 did not have to mint a single character either. Both sentences are assembled from words this same file is already saying, and the nearest of them, `每份 X 克大于整批 Y 克。`, is a warning two branches away in the same function doing the same job for a different pair of numbers. That sentence is the structural model for the first note here, `大于` included.

### Composed

| key | EN | CN |
|---|---|---|
| `yhBatchOverLines` | Typed {n} g — bigger than the ingredient total ({m} g). Cost per gram divides by {n} g. | 手动填写 {n} 克,大于原料合计 {m} 克。每克成本按 {n} 克折算。 |
| `yhServingsSpan` | {s} × {g} g = {t} g — the batch is {b} g. | {s} 份 × {g} 克 = {t} 克 —— 整批 {b} 克。 |

### Where each Chinese word already lives

| word | the live string it comes from | where |
|---|---|---|
| 手动填写 | `手动填写` — the "Type it myself" switch on this very hint | `yieldSwitch`, same file |
| 大于 | `每份 X 克大于整批 Y 克。` — a serving bigger than the whole batch | `servHint`, same file |
| 原料合计 | `按原料合计填写(X 克)` — the offer this note now sits beside | `batchHint`, same file |
| 每克成本 | `每克成本` — the Cost per gram row of the cost breakdown | `breakdownHtml`, same file |
| 折算 | `整批的总克数,用于折算每克成本。` — the sentence this note replaces when it fires | `batchHint`, same file |
| 整批 | `整批的总克数…`, `整批成本` (Batch cost) | `batchHint` / `breakdownHtml`, same file |
| 份 | `每份成本` (Cost per serving), `每份 X 克…` | `breakdownHtml` / `servHint`, same file |

**THE SECOND NOTE IS ALMOST ALL NUMERALS, ON PURPOSE.** `12 份 × 220 克 = 2640 克 —— 整批 5000 克。` is one multiplication and two nouns. CLAUDE.md's standing preference — *"a numeral or a name often needs no label at all"* — is at its strongest here: the arithmetic **is** the sentence, and the operator does not need to be told which of the three numbers is wrong once he can see all three multiplied out.

### Rejected

- **Rejected: `批量大小` for the typed batch in the first note.** It is live in this file (`请修改该条的单位,或手动填写批量大小。`) and it names the FIELD. The note is not about the field, it is about the number typed into it, and `手动填写 5000 克` says whose number it is — which is the fact in dispute.
- **Rejected: calling either note an error — `错误`, `不符`, or the locked `单位不符` shape.** Neither disagreement is knowably a mistake. A batch smaller than its lines is an ordinary reduction on the stove; a batch larger than them can be water poured in and never written down; a serving count short of the batch can be a tail left in the pot. `单位不符` is locked for a condition that IS always a fault (2026-08-27, this document), and borrowing its register here would teach an operator to read a real fault as a shrug.
- **Rejected: `请修改` (please change) on either note.** The existing unit-mismatch refusal ends that way because there is one right answer. Here there is not, and the fix — `按原料合计填写(2616 克)` — is already a button on the same line.
- **Rejected: stating the two per-gram costs (`¥0.0218/g` 对 `¥0.0417/g`) in the first note.** It is the most persuasive form of the fact and it is what Ash actually asked about. It is left out because the hint is a function of the yield alone and reaching the cost from there would give one sentence two sources of truth; the breakdown a tab away already prints 每克成本 from the derivation that owns it.

**WHAT IS NOT SAID, AND IS DELIBERATE.** The first note fires in **one direction only** — a typed batch ABOVE the ingredient total. Below it is the safe direction: the same cost over fewer grams makes cost per gram too high, which overcharges the recipes downstream and surfaces as a margin that looks too good. Above it is the direction nobody notices, because everything downstream is quietly undercharged. The thresholds (5% for the batch note, 10% for the servings note) are judgements about noise rather than facts, named as constants in the code and covered by `scripts/test_recipe_yield_auto.js`.

## What today's batch owes — the kitchen queue (2026-09-09)

The block `public/m.html` gains above 厨房制作队列's request list, and the row it puts on the phone's Home, under `docs/tacet-consolidation-decisions.md` §84. Register: OPERATOR (Rule 1) — it is read by the people who cook, on their own phone, and no customer ever sees it.

**THE CHINESE IS LIFTED VERBATIM AND NOTHING NEW WAS COMPOSED IN IT.** `有客户订单等待` is live in this same file at the "Ask the kitchen" purpose picker, where it is the sub-line of the *For an order* option — a customer order waiting on something the kitchen has to make. That is precisely what this block lists, on the same screen, in the same register, to the same reader. Rule 4's first preference is to copy a live pair and this is one, so it is copied rather than improved on.

### Taken verbatim (no new Chinese)

`有客户订单等待`, from `public/m.html`'s kitchen-request purpose picker (`opt('order','For an order','用于发货','A customer is waiting on it','有客户订单等待')`).

### Composed — the ENGLISH half only

| key | EN | CN | provenance |
|---|---|---|---|
| owed block heading, and the Home row | Customer orders waiting | 有客户订单等待 | CN **VERBATIM LIVE**; EN **COMPOSED** by Claude Opus 5 under Rule 4's standing delegation |

**Only the English moved, and only because the grammar of a list heading is not the grammar of an option.** The live English half is *A customer is waiting on it* — a singular sentence about one request, correct where it stands and wrong over a list of several products owed to many people. The Chinese half needed no such change: `有客户订单等待` is already number-neutral (*there are customer orders waiting*), which is why it could be taken as it is. **The half Rule 4 exists to guard is therefore untouched**; what was composed is the half a native reader of this document can check at a glance.

**NO SECOND STRING FOR THE ROWS, and that is deliberate.** Each row is a product name and a numeral — `青酱卷 18` — with no unit word, no verb and no status chip. The vocabulary rule this follows is the standing one in `CLAUDE.md`: *a numeral or a name often needs no label at all.* A row saying `18 件待制作` would add a word to every line to repeat what the heading has already said once.

**REJECTED: `待制作`, and it is the obvious candidate.** It is live, it is on this very screen, and it means exactly "to make" — but it is live AS THE TAB the block would sit directly above (`seg('active',T('To make','待制作'))`), and its empty state `暂无待制作` sits inside that tab. Reusing it for a second, differently-sourced list on the same screen would put one word over two lists that are not the same list: the tab holds requests somebody typed, the block holds orders customers placed. **The tab's word is left to the tab.**

**REJECTED: naming today's batch in the heading** — "Today's batch owes", which is how the concept was described in conversation. `lib/batch-owed.js` deliberately knows no production cadence (§84, and a case in `scripts/test_batch_owed.js` pins it): it cannot tell whether today is a cooking day, so a heading promising *today's batch* would overclaim on a morning the kitchen is not cooking, while the units are owed either way. The heading names WHO is waiting, which is true on every day of the week.

## The pre-order window — the Fresh batches card (2026-09-09)

The three controls `public/retail-admin.html`'s Fresh batches card gains under `docs/tacet-consolidation-decisions.md` §85: when pre-orders stop for the day, how many of each fresh item to offer while they are open, and which platforms are in it. Register: OPERATOR (Rule 1) — the back-office settings card, never seen by a customer.

**THE ONE WORD THAT WAS NOT ALREADY OURS IS LIFTED FROM THE PLATFORMS THEMSELVES**, which is Rule 4's SECOND preference and the right one here: this feature exists to publish to Meituan and Eleme, and both of them already have a word for an order placed ahead rather than now.

- **`预订` — LIFTED FROM THE SOURCE.** `lib/meituan-browser.js` matches `/预订/` against Meituan's own store-status text, where `仅接受预订` is that platform's merchant wording for "reservation only"; `lib/eleme-browser.js` and `scripts/eleme-daemon.js` both read Eleme's `预订单` for an order booked into a later window. It is the merchant-facing word on both screens this setting governs, and an operator who manages those shops reads it there already.

### Taken verbatim (no new Chinese)

`可售数量` and `渠道`, both from the live `Stock, and how much of it each channel may sell · 库存,以及各渠道可售数量`. `截单` from this same card's own live `Order-by hour · 当日截单`. The three channel names as they already ship: `美团`, `饿了么`, and `gzgrocery · 管易` from the Sales screen's channel row.

### Composed — arrangements of the above

| key | EN | CN | provenance |
|---|---|---|---|
| lock-hour row | Pre-order cut-off | 预订截单 | **COMPOSED** — `预订` LIFTED from Meituan's 仅接受预订 / Eleme's 预订单; `截单` LIVE in this card's 当日截单 |
| allowance row | How many to offer | 预订可售数量 | **COMPOSED** — `预订` as above; `可售数量` VERBATIM from 各渠道可售数量 |
| channels row | Channels | 渠道 | VERBATIM from the same live string |

**Composed by Claude Opus 5 under Rule 4's standing delegation.**

**THE LOCK ROW IS BUILT TO READ AS THE SIBLING OF THE ROW ABOVE IT.** `当日截单` already sits two rows up meaning "after this hour, today is gone"; `预订截单` says the same shape of thing about a different question, and the two are meant to be read together as one pair of deadlines. That parallel is why `截单` was reused rather than a second verb found for closing a window.

**REJECTED: `预售`.** It is the more common Chinese for "pre-sale" and appears nowhere in this tree — but it carries a marketing sense (a product launched for advance purchase) that is not what this is. Nothing is being launched: a shelf is empty and the kitchen is three hours from filling it. `预订` is the word both platforms use for the narrower thing, and it is the word an operator meets in their own Meituan back office.

**REJECTED: restructuring the allowance row to need no new label.** Tried, per Rule 4's preference for a reshaped label over a minted one. The number cannot stand alone the way the owed list's numerals can (`docs/tacet-consolidation-decisions.md` §84): a bare box on a settings card, between an hour and a set of checkboxes, says nothing about what it counts, and the one thing an operator must not misread here is whether it means units per product or per order. It is per product, and the label is what says so.

## Asking the buyer to buy — the kitchen's purchase request (2026-09-09)

The strings for §86: the kitchen's **Ask to buy** screen on `/m`, and the buyer's **From the kitchen** picker in `public/retail-admin/16-purchasing.js`. Register: **OPERATOR** (Rule 1) throughout — a cook and a buyer read these; nothing here reaches a customer. Composed under Rule 4's standing delegation, by Claude Opus 5.

**THE ONE WORD EVERYTHING TURNS ON IS `采购申请`, AND IT IS NOT `物料申请`.** Preference 1 does not reach it: no shipped pair names this thing, because until now the kitchen could not ask for anything to be bought. Preference 3 then had a real choice to make, and it is a choice about meaning rather than taste. **`物料申请` / `领料` is requisitioning material OUT OF A STORE somebody already owns.** That is not this. This asks the company to **buy** — a supplier is paid, an expense posts, a price is written back. `采购申请` is the standard Chinese term for exactly that document, both of its words are live in this product (`采购` on the Purchasing rail and the phone's own row; `申请` inside `发起补货申请`, the sibling capability's label), and it is the arrangement that is new rather than the vocabulary.

**THE SIBLING IT IS SHAPED AGAINST IS `发起补货申请`** — `restock:request`, "Ask for stock (and ask the kitchen)". The capability label here is that string with its noun swapped: `发起采购申请`. The two keys are deliberately different keys (§86 part five), and their labels being one word apart is the point: an admin reading the matrix should be able to see that one moves Roots' own goods and the other spends money.

### Composed

| where | EN | CN |
|---|---|---|
| `/m` row + screen title | Ask to buy | 采购申请 |
| capability `production:request` | Ask the buyer for materials | 发起采购申请 |
| receipt heading | Sent to the buyer | 已发送至采购 |
| receipt line | The buyer sees it now. Nothing is ordered until they place it. | 采购已收到。下单后才会生成采购单。 |
| screen intro | The buyer orders it — nothing is ordered until they place it. | 由采购下单 — 下单后才会生成采购单。 |
| empty picker | No materials match | 没有匹配的物料 |
| empty material list | No materials yet | 还没有物料 |
| refused for capability | This account cannot raise purchase requests. | 此账号无法发起采购申请。 |
| list unreadable | The material list could not be read. Try again. | 无法读取物料列表，请重试。 |
| modal sub-head | Materials the kitchen has asked for. Ticked lines become one draft order you can price and place. | 厨房申请的物料。勾选的行会生成一张采购单草稿，可在此定价并下单。 |
| modal search | Find a material or request | 搜索物料或申请单 |
| modal no match | Nothing matches that search. | 没有匹配的申请。 |
| modal empty | The kitchen has not asked for anything. | 厨房暂无物料申请。 |
| the draft note | This makes a DRAFT. Nothing is ordered and nothing reaches the books until you mark it Ordered. | 这里只生成草稿。标记「已下单」后才会正式下单并记入账目。 |
| nothing ticked | Tick the lines you are buying. | 勾选要采购的物料。 |
| supplier placeholder | Optional — set it later | 可稍后填写 |
| the button | Draft {n} lines / Make draft | 生成草稿 ({n} 行) / 生成草稿 |
| success toast | {po} drafted from {n} lines ✓ | 已生成草稿 {po}，共 {n} 行 ✓ |
| refusal toast | Already ordered: | 已下单: |

### Lifted verbatim, not composed

Every one of these is a shipped pair reused unchanged, and they are listed so the composed table above is not read as the whole of what the two screens say.

| pair | where it already lives |
|---|---|
| From the kitchen · 厨房申请 | `public/m.html` — `n 项厨房申请已完成`, the Ready-from-the-kitchen toast |
| Search materials · 搜索物料 | `public/retail-admin/19-recipes.js`, the materialise dialog |
| Asked by · 申请人 | `routes/retail.js`, the tenant-request notification |
| Select all shown · 全选当前 | `16-purchasing.js`, the kitchen picker directly above |
| File under store · 归属门店 | `16-purchasing.js`, the same picker's foot |
| Make draft (verb) · 生成草稿 | `16-purchasing.js` `生成草稿单` (Open draft order), reorder panel |
| 记入账目 | `public/m.html` receive copy — `采购金额记入账目` |
| 「…」 around a control's name | `public/m.html` receive copy — `请返回并使用「逐项收货」` |
| Quantity · 数量, Supplier · 供应商, Cancel · 取消, Loading… · 加载中…, Working… · 处理中…, Ordered · 已下单, Materials · 物料, purchase order · 采购单 | throughout |

### Where each new Chinese word comes from

| word | the live string it comes from | where |
|---|---|---|
| 采购 | `采购` — the Purchasing rail tab and the phone's Purchasing row | `retail-admin.html` / `m.html` MORE_GROUPS |
| 申请 | `发起补货申请(含向厨房下单)` — `restock:request`'s own label | `lib/capabilities.js` |
| 发起 | the same label | `lib/capabilities.js` |
| 已发送至 | `已发送至厨房` — what Ask the kitchen says after a send | `m.html` `screenAskKitchen` |
| 采购单 | `无法加载这张采购单。`, `还没有采购单` | `m.html`, throughout Purchasing |
| 下单 | `向厨房下单` — Ask the kitchen's own row label | `m.html` MORE_GROUPS |
| 生成 | `生成草稿单` (Open draft order) | `16-purchasing.js` reorder panel |
| 没有匹配的 | `没有匹配的商品` — the product picker's empty state | `m.html` `rqPicker` |
| 无法读取 | `无法读取完整商品目录。` — the catalogue-fallback note | `m.html` `rqPicker` |
| 还没有 | `还没有采购单` — Purchasing’s own empty state on the phone | `m.html` `screenPurchasing` |
| 勾选 | `勾选需要导入的采购单。` — the kitchen picker's own prompt | `16-purchasing.js` |
| 草稿 | `复制后为草稿,可在此调整数量。` | `16-purchasing.js` kitchen picker |
| 定价 / 门店 / 行 | `定价` (pricing rows), `归属门店`, `共 N 行` shapes | throughout Purchasing |

### Rejected

- **Rejected: `物料申请` and `申请物料` for the screen.** Both read as requisitioning material out of a store the company already holds — `领料`'s territory. Nothing is drawn from a shelf here; a supplier is paid. Naming a purchase after a withdrawal is the kind of wrong word that survives for years because it is not obviously wrong.
- **Rejected: reusing `申请补货` verbatim.** It is live, it is the closest pair in the product, and it means *restock* — goods moving between Roots' own locations, spending nothing. Using it would say the opposite of what this screen does, and would also make the two screens indistinguishable in the More list where they sit four rows apart.
- **Rejected: `采购订单` for what the conversion produces.** `采购单` is what this product has always called a purchase order, in every one of the twenty-odd strings that name one. A second word for the same document, introduced on a new screen, is how a glossary starts drifting.
- **Rejected: showing the buy price on the kitchen's screen and writing a pair for it.** Not a vocabulary decision — the server sends no cost column at all (§86 part five) — but recorded here so that a later reader who finds a price-shaped gap in this table knows it was never meant to be filled.
- **Rejected: `已发送` alone for the receipt heading.** It is live (`screenAskStock`'s own receipt) and it is shorter. `已发送至采购` is preferred because a cook has three request screens now, and a receipt that does not say WHO it went to is the one that gets misread the morning somebody uses two of them.

## Typing the quantity on Ask to buy (2026-09-09)

An amendment to *Asking the buyer to buy* above. §86's screen shipped with steppers only, and Ash asked the obvious question from the kitchen: *"what happens if need 100pc of something."* Tapping the number now opens a field. Register: **OPERATOR** (Rule 1).

**ONE COMPOSED PAIR AND ONE VERBATIM LIFT, and the composed one is a live sentence with two words taken OUT rather than any put in.** The Add Stock card already refuses a non-number with `请输入制作数量——整数，0 或以上。`. This screen needs the same refusal minus two facts that are not true here: it is not a *batch* being made (`制作`), and the figure need not be a *whole number* (`整数`) — a material bought by the kilo can honestly be asked for as 2.5, `material_request_items.qty` is REAL, and the route takes any finite number above zero. Removing what does not apply is preferred to writing a second sentence beside the first.

### Composed

| where | EN | CN |
|---|---|---|
| a typed quantity that is not a number | Enter a number, 0 or more. | 请输入数量，0 或以上。 |

### Lifted verbatim

| pair | where it already lives |
|---|---|
| 数量 | `数量` — the Quantity column of the buyer's own picker, and throughout Purchasing |
| the sentence this one is cut from | `请输入制作数量——整数，0 或以上。` — `qsTypeCommit`, `public/m.html` |

### Rejected

- **Rejected: reusing `请输入制作数量——整数，0 或以上。` unchanged.** It is live and it is one keystroke of effort. It says *制作* — made — of a material nobody makes, and it demands a whole number the column does not require. A borrowed sentence that is wrong in two places is worse than a cut-down one that is right.
- **Rejected: a separate pair for the field's own label.** `数量` serves, and it is what the buyer's picker already calls the same column. CLAUDE.md's standing preference — a numeral or a name often needs no label at all — applies to the cell itself: it shows the number and nothing else.
## The tenant's own expense categories (2026-09-09)

The strings for §87 part two: the **Categories** sub-view on Finance, the one
excluded line it adds beneath the Summary staircase, and the two refusals the
server can answer with. Register: **OPERATOR** (Rule 1) throughout — an owner or
a bookkeeper reads these; nothing here reaches a customer. Composed under Rule
4's standing delegation, by Claude Opus 5.

**EVERY CHINESE WORD BELOW IS ALREADY LIVE IN THIS PRODUCT, and only the
arrangements are new.** Preference 1 reaches most of this outright: Finance
already ships `营业费用`, `分类`, `加载失败`, `此操作无法撤销`, and the team screens
already ship `停用` / `启用` / `已停用` for retiring a thing without deleting it.
That last trio is the important reuse — **hiding a category is the same act, in
the same words, as deactivating a teammate**, and an operator who has met one
should not have to learn a second verb for the other.

**THE ONE PHRASE THAT CARRIES THE DECISION IS `不计入营业费用`**, and it is
`营业费用` — the Summary's own row label, live since §36 — with the negation
`不计入` in front of it. `不计入` is live in two places that mean exactly this:
`物料不计入门店库存` and the recipe screen's `其成本不计入`. **The pairing is
deliberate: the excluded line must read as the negative of the row above it, in
the same words, or the screen is asserting two different ideas.**

**`租金` AND NOT `房租`, WHICH IS THE TRAP THIS FILE EXISTS FOR.** Both mean rent.
`22-finance.js` carries both — but `房租` appears only inside a comment about two
spellings of one category colliding, and the string this surface actually SHIPS
is `您记录的租金、工资和一次性费用…`. So the placeholder and the empty state use
`租金`, taken from the live sentence one screen away, and `房租` is left where it
is: in a comment, as an example of the defect.

### Composed — arrangements of live words

| where | EN | CN |
|---|---|---|
| sub-view tab | Categories | 分类 |
| panel intro | Your own list. Expenses are filed against these, and only these are offered when someone records one. | 本店自己的分类列表。记录支出时只会显示这些分类。 |
| add placeholder | Rent | 租金 |
| row flag | Operating expense | 营业费用 |
| usage, none | Not used | 未使用 |
| usage, some | Used by {n} | {n} 条使用 |
| retire control | Hide | 停用 |
| restore control | Restore | 启用 |
| retired badge | Hidden | 已停用 |
| hide confirm | Hide this category? | 停用该分类？ |
| hide confirm body | It stops being offered when recording an expense. Expenses already filed under it keep it, and keep its setting. | 记录支出时不再显示该分类。已使用该分类的支出保持不变，其设置也保留。 |
| delete confirm | Delete this category? | 删除该分类？ |
| delete confirm body | Nothing has been filed under it. This cannot be undone. | 尚无支出使用该分类。此操作无法撤销。 |
| delete refused | "{name}" is used by {n} expenses. Hide it instead — hiding keeps those records exactly as they are. | “{name}”已被 {n} 条支出使用。请改为停用 — 停用不会改动这些记录。 |
| empty list | No categories yet. Add the ones this business spends money on — rent, wages. | 还没有分类。请新增本店的支出分类 — 租金、工资。 |
| load failed | Could not load the categories. | 分类加载失败。 |
| the excluded line | Not an operating expense | 不计入营业费用 |
| beneath it | Recorded, and not counted in the figures above. | 已记录，未计入上方数字。 |
| server refusal | name required | 分类名称必填 |
| server refusal | that category already exists | 该分类已存在 |

### Where each Chinese word comes from

| word | the live string it comes from | where |
|---|---|---|
| 分类 | `Category · 分类` — the transaction form's own field | `retail-admin.html` |
| 营业费用 | `Operating expenses · 营业费用` — the Summary row this negates | `22-finance.js` |
| 不计入 | `物料不计入门店库存`, `其成本不计入` | `m.html`, `19-recipes.js` |
| 已记录 | `已记录` | `20-waste.js` |
| 停用 / 启用 / 已停用 | the team screen's deactivate / reactivate controls | `12065:screenTeam` in `m.html`, `backend-team.js` |
| 添加 | `添加` | throughout |
| 租金 / 工资 | `您记录的租金、工资和一次性费用将显示在此处` — Transactions' own empty state | `22-finance.js` |
| 未使用 | `未使用` | `retail-admin.html` |
| 加载失败 | `加载失败`, `财务数据加载失败。` | `05-marketing.js`, `22-finance.js` |
| 此操作无法撤销 | the delete-a-transaction confirm, one screen away | `22-finance.js` |
| 保持不变 | `留空则保持不变` | `retail-admin.html` |
| 请改为 | `改为` is live throughout; `请` prefixes every instruction on this surface | throughout |
| 名称必填 | `公司名称必填`, `英文名称必填` | `backend-signup.js`, `18-materials.js` |
| 已存在 | `成分已存在`, `编码已存在` | throughout |

### Rejected

- **Rejected: `不计入利润` or any phrasing built on profit.** It is the sentence an
  operator would say out loud, and it is wrong in the direction that matters: the
  money IS excluded from the operating-expense total, and it is NOT subtracted
  from net. A label naming profit would describe an arithmetic the screen
  deliberately does not perform, and the first person to reconcile the card
  against it would find the figures do not do what the label says.
- **Rejected: `隐藏` for Hide.** It is live (`已隐藏`, on products) and it is the
  literal word. `停用` is preferred because this is not a display toggle: the
  category stays in the list, keeps governing rows already filed under it, and is
  restored rather than un-hidden. That is deactivation, and the product already
  has a word for it that carries exactly those properties.
- **Rejected: `删除` for the retire control, with a separate archive elsewhere.**
  Delete exists here and means delete — it is refused the moment any expense
  names the category, for the reason §87 gives — so a second control saying the
  same word would be two doors with one label, one of which usually refuses.
- **Rejected: composing a pair for the operating flag as a question
  (`是否计入营业费用？`).** The control is a checkbox beside a name, in a row of
  them; a question mark on every row reads as a form asking twenty questions
  rather than a list stating twenty facts. The label is the fact the tick means.
- **Rejected: seeding the list with `租金`, `工资` and the rest as starter rows.**
  Not a vocabulary decision — §36 ships the list empty and §87 keeps it empty —
  but recorded here so a later reader who finds this table naming rent and wages
  does not take it as evidence they were ever meant to be created for anybody.

## Saying what you spent — the expense claim on the phone (2026-09-09)

The strings for §87 step two: the **Expense** screen on `/m`, its receipt, the
list of what one person has sent, and the capability that opens it. Register:
**OPERATOR** (Rule 1) throughout — a driver, a cook and a shop manager read
these. Composed under Rule 4's standing delegation, by Claude Opus 5.

**THE SCREEN'S WHOLE JOB IS TO SAY THAT THIS IS NOT MONEY YET**, and two of the
pairs below carry that alone: `审批通过后才会记入账目。` under the button, and
`尚未记入账目。审批通过后才会记录。` on the receipt. `记入账目` is lifted verbatim
from the phone's own receiving copy (`采购金额记入账目`) for exactly that reason —
a cook who has received a delivery has already met the phrase that means *this
reaches the books*, and the claim screen is telling them the opposite about
itself in the same words.

**`个人支付` RATHER THAN A WORD FOR REIMBURSEMENT.** `报销` is the standard term
and it is NOT used, because it names the *repayment* and this field names *whose
money was spent* — a claim paid from the company account is still a claim, and a
control offering "reimbursement / company" would be asking two questions in one.
Both halves of `个人支付` are live (`个人` on a customer record, `支付` throughout
checkout), and the pair beside it is the single live word `公司`.

**`应付您` IS THE DEBT, AND IT IS THE SAME WORD THE PRODUCT ALREADY USES FOR ONE.**
`应付` is live in `供应商发票金额即应付账款` — what the business owes a supplier —
and an employee who fronted ¥38 is owed on the same footing. A second vocabulary
for the same fact is how two numbers that should reconcile stop being comparable.

### Composed — arrangements of live words

| where | EN | CN |
|---|---|---|
| capability `expenses:submit` | Record an expense claim | 登记费用申请 |
| capability section | Expense claims | 费用申请 |
| the More row, and the screen | Expense | 费用申请 |
| field | Who paid | 由谁付款 |
| chip | My own money / Own money | 个人支付 |
| under the chips, own money | The shop owes you this once it is approved. | 审批通过后本店应付给你。 |
| under the chips, company | Paid from the shop's own account. Nothing is owed to you. | 由本店账户支付，无需付给你。 |
| field | Receipt | 照片 |
| control | Remove | 移除 |
| under the button | This is not recorded in the accounts until it is approved. | 审批通过后才会记入账目。 |
| receipt heading | Sent for approval | 已提交，等待审批 |
| receipt line | It is not in the accounts yet. Nothing is recorded until it is approved. | 尚未记入账目。审批通过后才会记录。 |
| receipt control | Record another | 再记一笔 |
| list heading | What you have sent | 你提交的记录 |
| list total | Owed to you | 应付您 |
| status | Waiting | 待审批 |
| status | Owed | 应付您 |
| status | Not approved | 已拒绝 |
| no categories | Your shop has no expense categories yet. This will be filed without one — whoever keeps the books can add categories in Finance. | 本店尚未设置支出分类。这笔将不带分类提交 — 可请记账人在「财务」中新增分类。 |
| load failed | Could not load your shop's categories. | 无法加载本店分类。 |
| refused | Enter an amount above zero. | 请输入大于零的金额。 |
| refused | Could not read that photo. | 无法读取该照片。 |
| server refusal | say who paid | 请选择付款方式 |
| server refusal | that photo is not an image the app can read | 无法读取该照片 |
| server refusal | that photo is too large | 照片过大 |

### Lifted verbatim, not composed

| pair | where it already lives |
|---|---|
| Amount · 金额 | `routes/finance-transactions.js` — `金额必须大于零` |
| Category · 分类 | the Finance transaction form |
| Note · 备注 | the same form |
| Date · 日期 / Shop · 门店 | throughout |
| Submit · 提交 / Sending… · 提交中… / 提交失败。 | the request screens on `/m` |
| Add a photo · 拍照 | `public/m.html` |
| Company · 公司 / optional · 可选 / Approved · 已通过 | throughout |
| 记入账目 | `public/m.html` receive copy — `采购金额记入账目` |
| 日期必填 / 金额必须大于零 | `routes/finance-transactions.js`, reused byte for byte |

### Rejected

- **Rejected: `报销` anywhere on this screen.** It is the standard word for an
  expense reimbursement and it names the repayment, not the spending. Half the
  claims this screen takes are paid on the company account and are never
  reimbursed at all; a screen headed with that word would be wrong for them
  before anybody typed a figure. It is the right word for the SETTLEMENT step,
  and is left unspent for it.
- **Rejected: a placeholder example in the Note field.** The one that read well
  in English — an airport run for a Tianhe order — needed two Chinese words this
  product does not ship, and the field already says Note and says it is optional.
  Rule 4 prefers restructuring a label over minting a pair, and here the label
  needed no restructuring: the placeholder was simply removed.
- **Rejected: `费用` alone for the More row.** It is live and it is shorter.
  `费用申请` is preferred because the row opens a screen that RAISES something for
  somebody else to approve, exactly as `采购申请` does two rows above it — and a
  cook who has met one should read the other as its sibling rather than as a
  report of what the shop has spent.
- **Rejected: a money marker on the capability, and a pair for an approving key.**
  Neither is a vocabulary decision, but both are recorded here so a later reader
  who finds an approval-shaped gap in this table knows it was left deliberately:
  the approving key lands with the screen that gives it something to gate.

## Deciding a claim — the approvals screen (2026-09-09)

The strings for §87 step three: the **Approvals** screen on `/m`, the mark a
claim-posted row wears on the desktop Transactions ledger, and the capability
that opens both. Register: **OPERATOR** (Rule 1). Composed under Rule 4's
standing delegation, by Claude Opus 5.

**THE LINE UNDER THE QUEUE IS THE MIRROR OF THE ONE UNDER SUBMIT.** The claim
screen says `审批通过后才会记入账目。` — *this is not in the accounts until it is
approved*. This screen says `审批通过后即记入本月账目。` — *approving records it in
this month's accounts*. Same clause, opposite side, deliberately: the person
tapping Approve is the other half of the sentence the person tapping Submit
already read, and one word (`才会` → `即`) is the whole difference between them.

**`本人提交` MARKS A SELF-APPROVAL RATHER THAN REFUSING ONE.** §87 part five
allows an approver to approve their own claim, and makes the record the guard —
so the row has to SAY so. `本人` is live (`本人签收`, the delivery signature) and
`提交` is live throughout; the pair is the two of them, and it reads as a fact
about the row rather than as a warning about the person.

### Composed — arrangements of live words

| where | EN | CN |
|---|---|---|
| capability `expenses:approve` | Approve expense claims | 审批费用申请 |
| why-note on that key | Approving a claim writes it into the books. | 审批通过后即记入账目。 |
| the More row, and the screen | Approvals | 审批 |
| section heading | Waiting | 待审批 |
| section heading | Already decided | 已处理 |
| under the queue | Approving records the expense in this month's accounts. | 审批通过后即记入本月账目。 |
| the button | Approve | 通过 |
| beside it | Reject | 拒绝 |
| on a row you raised yourself | Your own claim | 本人提交 |
| control | View photo / Hide photo | 查看照片 / 收起照片 |
| empty queue | Nothing waiting | 暂无待审批 |
| empty queue | Expenses your team records will arrive here for you to approve. | 团队登记的费用会出现在这里等待审批。 |
| queue cleared | Everything your team has sent has been decided. | 团队提交的记录都已处理。 |
| refused | Could not do that. | 操作失败。 |
| refused | Could not load the queue. | 无法加载列表。 |
| unknown submitter | Someone | 未知 |
| ledger mark, desktop | Staff claim | 费用申请 |
| ledger mark, desktop | Staff claim · own money | 费用申请 · 个人支付 |
| server refusal | approve or reject | 请选择通过或拒绝 |
| server refusal | this claim has already been paid back | 该申请已完成付款 |
| server refusal | this account cannot approve expense claims | 此账号无法审批费用申请 |
| ledger refusal | expenses from a staff claim cannot be edited directly | 费用申请产生的支出不能直接编辑 |
| ledger refusal | expenses from a staff claim cannot be deleted directly | 费用申请产生的支出不能直接删除 |

### Where the two ledger refusals come from

They are the PO pair with one noun swapped, and that is the point: the screen
already ships `关联采购单的支出不能直接编辑`, and a claim-posted row is refused for
the same reason a PO-posted row is. **A second way of saying it would suggest a
second reason.**

| the live string | the one beside it now |
|---|---|
| 关联采购单的支出不能直接编辑 | 费用申请产生的支出不能直接编辑 |
| 关联采购单的支出不能直接删除 | 费用申请产生的支出不能直接删除 |

### Rejected

- **Rejected: colouring Reject as a danger control, and giving it a confirm.**
  Not a vocabulary decision, but it decided the words: refusing a ¥38 taxi is an
  ordinary decision on a queue that exists to be cleared, and an alarm-red button
  with a "are you sure" behind it would make an approver hesitate over the tap
  they are meant to make. Approve is the CTA; Reject is a plain control beside it.
- **Rejected: `批准` for Approve.** It is the more formal word and it is not
  live here. `通过` is what this product already says about an approved payment
  (`款已通过`), and the status pill on the other screen already reads `已通过` —
  the button and the state it produces should be the same word.
- **Rejected: a pair saying an approver may not approve their own claim.** There
  is no such rule (§87 part five), so there is no string. Recorded because its
  absence is a decision.

## Paying it back — settlement (2026-09-09)

The strings for §87 step four: the **Owed to your team** block above the
approvals queue, and the two refusals the server can answer with. Register:
**OPERATOR** (Rule 1). Composed under Rule 4's standing delegation, by Claude
Opus 5.

**THIS IS THE THIRD LINE IN A SET OF THREE, and they are written to be read
together.** Under Submit: `审批通过后才会记入账目。` — not in the accounts yet.
Under the queue: `审批通过后即记入本月账目。` — approving records it. Under the
owed block: `标记已付不会改动账目 — 该费用在审批通过时已记入。` — and paying it
back changes nothing, because it was already recorded. **Each one is the same
clause seen from where the person is standing**, and the third exists because it
is the least obvious of the three: a screen that shows money and a button, with
no line under it, invites somebody to think the button spends something.

`标记已付` is `标记` (live throughout) with `已付` — the past form of `付款`, live
in `已付款`. `应付团队` reuses the `应付` of `应付账款`, which the product already
uses for what a business owes a supplier.

### Composed — arrangements of live words

| where | EN | CN |
|---|---|---|
| block heading | Owed to your team | 应付团队 |
| the control | Mark paid | 标记已付 |
| confirm title | Paid ¥{n} back? | 已付款 ¥{n}？ |
| confirm body | This records that {who} has been paid back. It does not change the accounts — the expense was recorded when it was approved. | 记录已向{who}付款。不会改动账目 — 该费用在审批通过时已记入。 |
| under the block | Marking paid does not change the accounts — the expense was recorded when it was approved. | 标记已付不会改动账目 — 该费用在审批通过时已记入。 |
| toast | Marked paid | 已标记付款 |
| count | claim / claims | 笔 |
| server refusal | only an approved claim can be paid back | 仅审批通过的申请可标记付款 |
| server refusal | this one was paid from the company account | 该笔由公司账户支付 |

### Rejected

- **Rejected: `报销` again, on the button this time.** This is where it would
  finally be the right word — v1.46 reserved it for exactly this step — and it is
  still not used. `标记已付` says what the control DOES: it records that a payment
  already made elsewhere has happened. `报销` names a process the shop runs, and a
  button carrying it would suggest this app pays the money out, which it does not
  and will not. The word stays unspent.
- **Rejected: one refusal for both cases.** A claim that is not approved and a
  claim that was paid on the company account are refused for different reasons,
  and a shared "cannot mark this paid" sends the operator looking for a
  permission problem that is not there.

## Choosing from thirty-one — the category picker (2026-09-10)

The strings for §87's amendment: the collapsed category row on the Expense
screen and the searchable picker behind it. Register: **OPERATOR** (Rule 1).
Composed under Rule 4's standing delegation, by Claude Opus 5.

**EVERY WORD BELOW IS LIVE AND FIVE OF THE SEVEN PAIRS ARE ARRANGEMENTS OF TWO
WORDS EACH**, which is what a picker should cost a glossary: `选择` + `分类`,
`搜索` + `分类`, `最近` + `使用`. `全部分类` is not composed at all — it ships
today on the product catalogue, and reusing it is what makes the picker read as
the same kind of control an operator has already met.

**`没有匹配的分类。` IS THE PRODUCT'S OWN EMPTY-SEARCH SENTENCE WITH ITS NOUN
SWAPPED** — `没有匹配的商品` on the product picker, `没有匹配的物料` on the
kitchen's. A third way of saying *nothing matched* would suggest a third kind of
nothing.

### Composed — arrangements of live words

| where | EN | CN |
|---|---|---|
| the collapsed row, nothing chosen | Choose a category | 选择分类 |
| picker search | Search categories | 搜索分类 |
| picker section | You used recently | 最近使用 |
| picker section, while searching | Results | 搜索结果 |
| empty search | Nothing matches that search. | 没有匹配的分类。 |

### Lifted verbatim, not composed

| pair | where it already lives |
|---|---|
| Category · 分类 | the Finance transaction form, and this screen's own label |
| All categories · 全部分类 | the product catalogue on `/m` |
| Close · 关闭 | throughout |

### Rejected

- **Rejected: `常用` (frequently used) for the recents heading.** It is the
  commoner word and it claims something the data does not support: the section is
  the last five categories this person filed under, newest first, not a frequency
  ranking. `最近使用` says exactly what the query does, and the day somebody
  changes the query to a real frequency count the label will be wrong in a way
  that is visible rather than plausible.
- **Rejected: a pair naming how many categories are in the list** (`31 个分类`).
  It is a number the operator can neither use nor act on, and it advertises the
  length of a list this control exists to stop them reading.

## Voiding a posted claim (2026-09-10)

§90 — reversing an approved staff claim after it has already posted a row to
the ledger. The screen is the Transactions row's new Void link and the
Approvals queue's status pill, both in `public/retail-admin/22-finance.js`; the
capability is `expenses:cancel` (`lib/capabilities.js`).

**MOST OF THIS SECTION IS NOT NEW VOCABULARY.** `Void` and `Voided` are the
waste ledger's own words (`public/retail-admin/20-waste.js`, `waste:void`) —
copied verbatim rather than composed, on Rule 4's first preference. What is
composed is the handful of places those words needed a sentence built around
them for a different object: a claim rather than a waste entry.

### Composed — an arrangement of live words, and noun/verb swaps of live shapes

| where | EN | CN |
|---|---|---|
| capability label (permission matrix) | Void a posted claim | 作废费用申请 |
| capability money note | Voiding removes the claim's entry from the ledger. | 作废会将该笔费用从账本中移除。 |
| Transactions row, confirm dialog title | Void this claim? | 作废这条费用申请？ |
| `/void` route, forbidden | this account cannot void expense claims | 此账号无法作废费用申请 |
| `/void` route, wrong status | only an approved claim can be voided | 仅审批通过的申请可以作废 |

The label is `作废` (below) plus `费用申请`, live as the Expense claims section
name and the `Staff claim · 费用申请` mark already on this same row. The two
refusal strings are the PO/claim refusal shape §87 already locked
(`此账号无法审批费用申请`, the approver's own forbidden message; `仅审批通过的申请可标记付款`,
settlement's own refusal), each with one word swapped for the same reason §87's
own pair swaps `编辑`/`删除` onto one noun: a second refusal for a sibling
condition reuses the shape rather than inventing a new one. The confirm title
is `作废这条费用申请？` — a direct noun-swap of the waste ledger's own
`作废这条损耗记录?`, changing only what is being voided.

### Lifted verbatim, not composed

| pair | where it already lives |
|---|---|
| Void · 作废 | the waste ledger's own Void button |
| Voided · 已作废 | the same file's status pill, and the affiliate referral / order-voiding screens |
| This removes the row from the ledger. This cannot be undone. · 此操作将从账本中移除该记录。此操作无法撤销。 | the Transactions screen's own Delete confirm, this same file |

The confirm dialog's body is the Delete confirm's body, unchanged: voiding
does remove the row from the ledger, so the sentence is still true of the new
action, and Rule 4 prefers reusing a fitting sentence over minting a
near-duplicate of it.

### Rejected

- **Rejected: reusing `expenses:approve`'s pill state instead of a new
  `Voided` one.** A voided claim was legitimately approved and later reversed
  by a different decision — collapsing it onto `Not approved · 已拒绝` would
  say the claim was refused from the start, which is false and erases the
  distinction §90 exists to keep (`voided_by`/`voided_at`, kept beside the
  untouched `decided_by` rather than overwriting it).
- **Rejected: composing a fresh sentence for the confirm body**, naming the
  claim specifically ("this reverses the claim and removes its ledger entry").
  The live Delete confirm already says exactly what happens to the row, in
  words this same screen already carries, and a second way of saying the same
  thing about a sibling row-removal is the kind of duplicate Rule 1 exists to
  prevent.

## Where the sales are — the money-in pointer (2026-09-10)

One pair, for one line under the Money in tile on Finance → Transactions.
Register: **OPERATOR** (Rule 1). Composed under Rule 4's standing delegation, by
Claude Opus 5.

**WHY A STRING EXISTS FOR THIS AT ALL.** Reported by Ash off the live screen: the
money-in tile reads ¥0 and the natural reading is that Finance is broken. It is
not — §36's *Transactions reads typed rows, not the order record* keeps orders
off this list by decision, and `income_entries` has held no row since 31 July.
**The figure was right and the screen said nothing**, so the operator is left to
conclude the only thing the screen supports. This line says where the sales
actually are.

**BOTH HALVES OF THE CN ARE ALREADY LOCKED IN THIS DOCUMENT, and that is the
whole argument for the pair.** `营收` is Ruling 1's Revenue, from the Finance
staircase section above; `汇总` is Summary, from the same locked table this
screen already renders. The composition adds `见` and nothing else — the word is
live in this register, in `public/retail-admin/02-settings-ops.js` among others.
A pointer whose two nouns are the exact words on the tab it points at is a
pointer an operator can follow; a pointer that renamed either of them would send
them looking for a screen that is not there.

### Composed — an arrangement of two locked words

| where | EN | CN |
|---|---|---|
| under the money-in tile, always | Sales revenue is on Summary | 营收见汇总 |

### Rejected

- **Rejected, and it was the first instinct: relabelling the tile `Other income ·
  其他收入`.** Ruling 1 of the Finance staircase section reserves `收入` for
  Income, a different thing in Tacet, and `scripts/test_finance_transactions.js`
  fails the build if `收入` renders on this screen at all. The ruling is right
  and the rename was wrong: `Money in · 进账` is locked, and a tile that renamed
  itself would still not have said where the sales went — which is the entire
  question the operator arrived with.
- **Rejected: `销售额` for the revenue half.** It is a fourth Chinese word for
  revenue on a screen where Ruling 1 exists precisely because there were already
  four. The pointer must use the word the destination uses.
- **Rejected: `营收在汇总`.** `在` states a location; `见` tells the reader to go
  and look, which is what a pointer is for.
- **Rejected: rendering the line only while the figure is ¥0.** What it names —
  revenue living one tab away — is equally true at ¥3,000, and a sentence that
  appeared only on an empty tile would read as an error message about the
  emptiness rather than a standing fact about the screen.


## Who put the row in the books — the ledger's provenance line (2026-09-10)

Two pairs, for the meta line under the description on Finance → Transactions.
Register: **OPERATOR** (Rule 1). Composed under Rule 4's standing delegation, by
Claude Opus 5. The decision is §92.

**WHY STRINGS EXIST FOR THIS AT ALL.** Ash, off the live screen: *"why it
doesn't show the user name that post this?"*, against a ¥200 row reading `Asher ·
personal · Staff claim`. The name he was looking at was the SPENDER's — §87 puts
that one in the description — and the person who let the money into the accounts
was on no screen at all, though `created_by` has carried them on every row since
the table existed.

**TWO PAIRS RATHER THAN ONE, AND THAT IS THE DECISION RATHER THAN A CONVENIENCE.**
Approving somebody else's spending is an exercise of authority §87 built a whole
capability around; typing a ledger row is not. A single label over both would
flatten an approval into a piece of typing, on the one screen where a bookkeeper
is asking who allowed the money out.

### Composed — a live word plus the suffix of a live pair

| where | EN | CN |
|---|---|---|
| meta line, a claim-posted row | Approved by *(name)* | 审批人 *(name)* |
| meta line, a hand-typed row | Entered by *(name)* | 录入人 *(name)* |

### Where each Chinese word comes from

| the half | already live as | where |
|---|---|---|
| 审批 | 待审批 · 审批通过后即记入本月账目。 · 审批费用申请 | the approvals screen, locked above |
| 录入 | 可录入交易 | `lib/roles.js`, the Bookkeeper role — this act, this screen |
| 录入 | 仅手动录入 · 可随时录入库存 | `04-orders.js`, `15-integrations.js` |
| 人 | Asked by · 申请人 | the approvals queue, the OTHER person on the same claim |

`申请人` is what makes the suffix right rather than merely available: the queue
already names the person who asked, so the ledger naming the person who decided
reads as the same kind of fact in the same shape.

### Rejected

- **Rejected: one label for both, `记账人`.** It is accurate for both acts and
  that is precisely the problem — it says a row was booked and not that an
  approval happened. It would also mint a word (`记账`) where two live ones
  already fit.
- **Rejected: `批准人` for the approver.** `批准` is live, but on the ORDERS
  side (`Approve · 批准`, refunds). The expense feature says `审批` throughout —
  `待审批`, `审批费用申请` — and a claim row that borrowed the refunds vocabulary
  would suggest the two flows are one.
- **Rejected: a bare name with no label at all.** The house rule prefers it
  ("a numeral or a name often needs no label"), and it fails here for a specific
  reason: the description on a claim row ALREADY ends in a person's name. Two
  unlabelled names on one row, meaning two different people, is worse than the
  silence it replaced.
- **Rejected: `Someone · 未知` where the name does not resolve.** It is live, on
  the approvals queue, where the name is the entire purpose of the column and a
  blank would read as a broken row. On a ledger row the meta line simply does
  not render — §1.12, an empty cell over an invented one.
- **Rejected: naming a Purchasing row.** One PO row is a collapse of several
  ledger rows whose posters can differ. It keeps `Posted by Purchasing ·
  采购单自动记入`, which is the true answer for a row nobody typed.

## Paying with points or the wallet at the counter (2026-09-10)

Two composed pairs and two lifted verbatim, for the four refusals
`POST /api/retail-admin/orders` can now answer with when a hand-keyed order tries
to spend store credit (§93). They render on both order forms — the desktop's New
order page (`public/retail-admin/04-orders.js`, `ordNewErrText`) and the phone's
(`public/m.html`, `onwErrText`) — which answer the same refusal with the same
words by that block's own standing rule. Register: **OPERATOR** (Rule 1).
Composed under Rule 4's standing delegation, by Claude Opus 5.

**NEITHER FORM CAN ACTUALLY CAUSE THESE, AND THEY ARE WRITTEN ANYWAY.** Neither
sends `points_to_use` or `use_balance`; the counter till does. But the endpoint
is shared, a code the server can send with no sentence on the page is what those
catalogues exist to prevent, and an unmapped code lands at the top of the form
rather than beside the control that caused it. Same reasoning, and the same
placement decision, as §44's three door codes already recorded above.

**TWO OF THE FOUR ARE NOT COMPOSED AND ARE LISTED SO NOBODY RE-MINTS THEM.**
`insufficient_points` is quoted whole from the admin's own shared error catalogue
(`public/retail-admin/01-core.js`) — the same code for the same fact, so it is
the same sentence. `insufficient_balance` is the live pair the web storefront and
the mini app both already ship for this exact code (`public/shop.html`,
`miniapp/pages/checkout/checkout.js`), carried across with the full stop this
catalogue's sentences all end in — the same normalisation 01-core had already
applied to `积分不足` before it.

**EVERY CONTENT WORD IN THE TWO COMPOSED PAIRS IS LIFTED FROM A LIVE STRING**,
checked against the tree rather than assumed: `积分` and `余额` (this document and
both checkout surfaces), `顾客` and `账户` (the desktop form's own customer block
and its `您的账户无权新建顾客`), `金额` (`某行单价金额不正确`), `请选择`
(`请选择可下单的渠道`), `付款方式` (the form's own Pay method label), `剩余`
(live in fourteen files), and `不足` in the shape `积分不足` above. The
composition is arrangement, not invention.

**WHY ANYTHING HAD TO BE COMPOSED.** No screen in this product has ever had to
say that a tender fell short of the bill, because until §93 no hand-keyed order
had a tender that could fall short: the counter took one wallet for the whole
amount or it took nothing. The customer checkout refuses differently — it can
re-price and ask again — so its strings answer a different question.

### Composed — two arrangements of live words

| where | EN | CN |
|---|---|---|
| credit asked for on an order with no account attached | Points and balance need a customer account. | 积分和余额需要顾客账户。 |
| a credit tender named on a bill it did not settle | Points or balance did not cover the whole amount. Pick a payment method for the rest. | 积分或余额不足以支付全部金额,请选择剩余金额的付款方式。 |

### Lifted verbatim — recorded, not composed

| where | EN | CN | from |
|---|---|---|---|
| more points asked for than the customer holds | There are not enough points for that. | 积分不足。 | `public/retail-admin/01-core.js`, the admin's shared error catalogue |
| the wallet moved between pricing and paying | Not enough balance. | 余额不足。 | `public/shop.html` and `miniapp/pages/checkout/checkout.js`, both for this code |

### Rejected

- **Rejected: `未付清` for "did not cover".** It is the natural phrase and it is
  not live anywhere in this repository — zero files. `不足以支付`, built from
  `不足` (locked here, in `积分不足`) and `支付` (live in fifty-four files), says
  the same thing out of words that are already in the product.
- **Rejected: reusing `积分不可抵扣运费。`** (`points_cannot_cover_shipping`, locked
  in 01-core) for the shortfall case. It is a live pair for a neighbouring fact
  and it names SHIPPING — which is precisely the fee that is not the problem
  here. A refusal that blames the wrong line is worse than a new sentence; the
  same trap `pointsRedeemableBase`'s own note records on the server side.
- **Rejected: leaving the two composed codes without a sentence** and letting the
  catalogues fall through to their generic "nothing was created" line. That line
  is correct and says nothing an operator can act on, and both catalogues are
  gated by suites that require a code to have a home — the gate would have been
  satisfied by the map entry alone while the screen stayed unhelpful.

## Chasing the carrier on a spoiled parcel (2026-09-11)

Seventeen composed pairs and fifteen lifted verbatim, for §98's late-parcel
case — the four steps that replaced the single "Mark handled — customer
contacted" button on a delayed air parcel. They render on both surfaces, the
desktop drawer (`public/retail-admin/04-orders.js`, `renderDelayCase`) and the
phone (`public/m.html`, `delayCaseCard`), which answer the same case with the
same words because §97 requires it and because a close the desktop refuses while
the phone allows it is the same button with the safety removed. Register:
**OPERATOR** (Rule 1). Composed under Rule 4's standing delegation, by Claude
Opus 5.

**EVERY CONTENT WORD IS ALREADY IN THE PRODUCT.** Not one of the seventeen
introduces a word this repository did not already ship; all seventeen are
arrangements, checked against the tree rather than assumed. The stock they are
drawn from: `承运商` (`lib/tracking.js`'s `其他承运商`, and both surfaces'
*Carrier site* link), `赔偿` and `申请延误赔偿` (the very banner being replaced),
`补发` (`public/retail-admin/10-extras.js`), `退款` (twenty-six files), `已拒绝`,
`已撤销`, `单号` (in `运单号`), `金额`, `收到`, `原因`, `步骤`, `全部`, `完成`,
`方可`, `关闭`, `尚未`, `以上`, `或`, `向`, and the `已` prefix that `已退款`,
`已拒绝` and `已处理` all already carry.

**THE ONE THING THAT COULD NOT BE CARRIED FORWARD IS THE CARRIER'S NAME.** The
old pair on both surfaces said `联系京东物流，申请延误赔偿。` and
`并向京东申请延误赔偿。` — 京东 hard-coded into the instruction. §98 rules that
nothing may name one carrier, because the claim is against whichever company
carried the parcel and other tenants ship with other carriers. So
`向承运商申请延误赔偿` is the same sentence with the company replaced by the live
word for the role. **That substitution is why most of this section exists**: once
the carrier is a role rather than a name, every step that mentions it needs
saying again.

**`已联系客户` IS NOT COMPOSED.** It is lifted whole out of the desktop button
this change removes (`标记已处理 — 已联系客户`) — the same fact, so the same
words, and the step that used to be the entire alert keeps the phrase operators
already read there. The perishable warning is lifted the same way, from the same
removed banner, and the phone's copy differs only in dropping the `<u>` tags its
card does not underline.

**THE TWO REFUSALS ARE ORDINARY CATALOGUE ENTRIES.** `case_not_closeable` and
`unknown_carrier` join `public/retail-admin/01-core.js`'s shared error map and
`orderErrorText` on the phone. `reason_required` and `amount_required` were
**deliberately not added**: both already exist in that catalogue, worded for
exactly this situation, and the first draft of this change duplicated them —
caught by `no-dupe-keys`, and recorded here so the next person reaches for the
catalogue before writing a sentence.

### Composed — arrangements of live words

| where | EN | CN |
|---|---|---|
| step 2, not yet started | Claim the delay off the carrier | 向承运商申请延误赔偿 |
| step 2, done | Claim filed with the carrier | 已申请延误赔偿 |
| step 2, the other answer | Not claiming | 不申请赔偿 |
| step 2, that answer's field | Why not claiming | 不申请的原因 |
| step 2, claim number field | Claim number | 赔偿单号 |
| step 2, amount field | Amount claimed | 申请金额 |
| step 3, not yet chosen | Replacement or refund | 补发或退款 |
| step 3, goods went back out | Replacement sent | 已补发 |
| step 4, the row | Carrier settled | 承运商赔偿 |
| step 4, amount field | Amount received | 收到金额 |
| step 4, the carrier paid | Carrier paid | 已赔偿 |
| step 4, the carrier refused | Carrier rejected the claim | 承运商已拒绝 |
| step 4, we dropped it | Claim withdrawn | 已撤销申请 |
| step 1, not yet done | Tell the customer — fresh items may not be safe | 联系客户 — 生鲜可能已不安全 |
| the close button, refused | Close once every step above is done. | 以上步骤全部完成后方可关闭。 |
| refusing the close server-side | The carrier claim is not finished yet. | 承运商赔偿尚未完成。 |
| a carrier code the server rejects | That carrier is not one the system knows. | 承运商不正确。 |

### Lifted verbatim — recorded, not composed

| where | EN | CN | from |
|---|---|---|---|
| step 1, done | Customer told | 已联系客户 | the removed `标记已处理 — 已联系客户` button, both surfaces |
| step 1, the advice | Perishable / fresh items may no longer be safe — advise them not to consume. | 生鲜/易腐产品可能已不安全，请告知客户`<u>`勿食用`</u>`。 | the removed desktop banner; the phone's copy drops the `<u>` tags |
| the card heading | Air shipment delayed | 空运延误 | both surfaces, unchanged |
| step 4, still waiting | Waiting on carrier | 等待承运商 | `等待承运商第一条更新。` (`public/m.html`) |
| step 3, money went back | Refunded | 已退款 | thirteen files |
| step 4, refused | Rejected | 已拒绝 | three files |
| step 4, dropped | Withdrawn | 已撤销 | five files |
| the close button | Mark handled | 标记已处理 | both surfaces, the same button |
| a reason is missing | Give a reason first. | 请先填写原因。 | `01-core.js`, `reason_required` — reused, not re-minted |
| an amount is missing | Enter an amount first. | 请先填写金额。 | `01-core.js`, `amount_required` — reused, not re-minted |

### Rejected

- **Rejected: keeping `联系京东物流，申请延误赔偿。` and its phone twin.** They are
  live, they are good sentences, and they name 京东. §98 refuses a carrier name
  anywhere in this feature. Keeping them would have cost nothing today and made
  the first non-JD tenant's screen wrong, which is the cheapest kind of wrong to
  avoid and the most expensive to find later.
- **Rejected: `结案` for closing the case.** It is the natural legal word for
  exactly this and it is live in **zero** files. `标记已处理` is the phrase both
  surfaces already put on this button, for this act, and it survives the change.
- **Rejected: `补偿客户` for the make-whole row.** `补偿` is live, so it was
  admissible, but it names an abstraction the operator never has to think about:
  the row offers two buttons and they are 已补发 and 已退款. `补发或退款` is the
  row saying which two, out of three words already in the product, and needs no
  new concept.
- **Rejected: `未申请赔偿。` and `尚未申请赔偿。` under step 4.** Both were written
  and both were deleted: the row already carries a `–` or a `○` and the words
  *承运商赔偿*, and a sentence restating the mark is a pair to keep correct
  forever in exchange for nothing.
- **Rejected: three explanatory bodies on the phone's ask sheets** (why a claim
  is recorded, why a reason is wanted, when the money reaches the books). Each
  was a composed sentence justifying a control to somebody who had already
  pressed it. The titles and the field labels say what is being asked; the
  reasoning belongs in `docs/tacet-consolidation-decisions.md` §98, where it now
  is, and not in a sheet an operator reads once.

## A carrier's compensation in the ledger (2026-09-11)

Two composed pairs, for §98 stage four — the refusals `routes/finance-transactions.js`
answers with when somebody tries to edit or delete the `income_entries` row a
delay case posted. Register: **OPERATOR** (Rule 1). Composed under Rule 4's
standing delegation, by Claude Opus 5.

**BOTH ARE THE CLAIM REFUSAL WITH ONE NOUN PHRASE SWAPPED**, which is the
cheapest a new pair gets after an outright lift. `费用申请产生的支出不能直接编辑`
and its delete twin are live in that same catalogue for the money-OUT
projection; these say the same thing about the money-IN one, so `费用申请`
becomes `承运商赔偿` (locked in v1.54, one section above) and `支出` becomes
`收入` (live in eight files). `产生的`, `不能直接编辑` and `不能直接删除` are
carried across untouched. **The parallel is the point**: a bookkeeper who has
met one of these refusals should recognise the other as the same rule about a
different document, and two differently-worded sentences would hide that.

**`承运商赔偿` IS REUSED, NOT RE-MINTED.** It is the pair v1.54 locked for the
delay case's own *Carrier settled* row, and it is also the mark the ledger row
now carries on the Transactions screen (`public/retail-admin/22-finance.js`,
beside *Posted by Purchasing* and *Staff claim*). One fact, one pair, three
places.

**NOTHING WAS COMPOSED FOR A CATEGORY, AND THAT IS A DECISION NOT AN OMISSION.**
The obvious move was an income category reading *carrier compensation*. The
income category list ships empty by §36 so the form cannot offer a wrong option,
so the posted row carries no category at all and the description does the work.
A pair minted here would have seeded that list by the back door.

### Composed — the claim refusal with one noun phrase swapped

| where | EN | CN |
|---|---|---|
| editing a ledger row a delay case posted | income from a carrier claim cannot be edited directly | 承运商赔偿产生的收入不能直接编辑 |
| deleting one | income from a carrier claim cannot be deleted directly | 承运商赔偿产生的收入不能直接删除 |

### Rejected

- **Rejected: one refusal covering both edit and delete.** The catalogue keeps
  them apart for the purchase-order and claim projections, in four separate
  entries, because the two acts fail for the same reason but in different
  sentences — and a person told "cannot be edited" while trying to delete goes
  looking for an edit they did not make.
- **Rejected: `物流赔偿` for the money's origin.** It is the more idiomatic
  phrase for delivery compensation and it is **not** live anywhere in this
  repository, while `承运商` is — in `lib/tracking.js`, on both order surfaces,
  and now in v1.54. Minting a second way to say the carrier would leave the
  product naming the same party two ways on two screens.
- **Rejected: naming the case in the refusal** (a claim number, an order
  number). The sentence has to fit a ledger row's error toast, the row's own
  description already carries carrier, order and claim reference, and a refusal
  that grows an identifier is one that has to be built rather than looked up.

## The fapiao that asks again (2026-09-11)

Two composed pairs and one lifted verbatim, for §99's fapiao chase — the Web
Push an operator now gets when a 发票 a customer asked for has not been issued,
and the switch that mutes it. They render from `lib/fapiao-reminders.js`
(the push titles) and `lib/push-events.js` (the switch). Register: **OPERATOR**
(Rule 1). Composed under Rule 4's standing delegation, by Claude Opus 5.

**MOST OF THIS FEATURE NEEDED NO STRING AT ALL, WHICH IS WHY THERE ARE ONLY
THREE.** The ordinary push title is the live pair Home's own row has printed
since that row existed. The per-order body is an order number, a sum of money
and a customer's name — three things that need no label in either language. The
digest body is a count and an age, and the age carries the live `最久` tail the
Home row already uses for exactly this figure. Home's month-end escalation adds
nothing: the label stays the same live pair and the colour is the whole message.
That is Rule 4's preference working — restructure a label so a live string fits
it, and a numeral or a name often needs no label at all.

**EVERY CONTENT WORD IN THE TWO COMPOSED PAIRS IS LIFTED FROM A LIVE STRING**,
checked against the tree rather than assumed: `本月` (the dashboard's own
`本月最低` / `本月获得` / `本月铁粉`), `开票` (`整单已恢复待开票`, and this
document's `待开票`), the `X内` construction meaning "within" (`三个月内食用`,
`5个工作日内退款`), `顾客` (`顾客备注`, `顾客申请开票的订单会显示在这里`),
`申请` (`申请发票`, `开票申请`), `尚未` (`该行尚未收货，无法…`) and `开具`
(`发票已开具`, `请在电脑端开具`). The composition is arrangement, not invention.

**WHY ANYTHING HAD TO BE COMPOSED.** Nothing in this product has ever had to say
that a tax period is about to close. The live fapiao vocabulary describes STATES
— requested, issued, auto-issue on or off — because until §99 the only thing any
surface did about an unissued 发票 was show that it was unissued. A deadline is
a different kind of sentence and had no live pair to carry it.

### Composed — two arrangements of live words

| where | EN | CN |
|---|---|---|
| push title, last three days of the month | Issue before month end | 本月内开票 |
| the mute switch's description, Profile → Notifications | A customer asked for a fapiao and it has not been issued. | 顾客申请了发票，尚未开具。 |

### Lifted verbatim — recorded, not composed

| where | EN | CN | from |
|---|---|---|---|
| push title, ordinary cadence; and the mute switch's label | Invoices to issue | 待开发票 | `public/m.html`, Home's `opsFires()` row and its desktop twin |

### Rejected

- **Rejected: `逾期` for the month-end title.** It is the natural word for
  "overdue" and it is wrong here in a way that matters: a 发票 requested on the
  26th and unissued on the 29th is not late by any agreement with the customer,
  it is approaching a TAX boundary. `逾期` would assert a broken promise the
  shop has not broken, and it is not live in this repository for anything.
- **Rejected: `催开发票` ("chase the fapiao").** Live nowhere, and it describes
  what the system is doing rather than what the operator must do. Every other
  fire on Home names the work.
- **Rejected: naming the month.** `八月发票待开` reads well on 29 August and is a
  lie on 1 September if a send is ever deferred across the boundary — which is
  precisely the case this title exists for. `本月` is true whenever it renders.
- **Rejected: a fourth pair for the Home row at month-end.** The row could say
  `本月内待开发票` when the colour changes. It would be a new string saying what
  the brick tint already says, on the one screen where the operator can see the
  date for themselves — `pageHead` prints it under the greeting.

## "Not today" on a waiting fapiao (2026-09-11)

One composed pair and one lifted, for §99's snooze — the control that defers a
fapiao push to tomorrow. It renders on the phone's Invoices screen
(`public/m.html`, the pending row's chip) and in the toast that confirms the
press. Register: **OPERATOR** (Rule 1). Composed under Rule 4's standing
delegation, by Claude Opus 5.

**ONE STRING CARRIES BOTH STATES, BY CHOICE OF CONTROL RATHER THAN BY WORDING.**
The control is the app's own `.chip`, which already has an `on` modifier, so a
filled chip reading 明天提醒我 says "remind me tomorrow: set" and an empty one
says it as an offer. A second pair for the set state — `已推迟`, `已暂停` — was
drafted and dropped: it would have been a new word for what the fill already
says, and neither candidate is live in this repository.

**NO DATE IS PRINTED ANYWHERE IN THE CONTROL.** The button promises tomorrow,
the server writes tomorrow, and a formatted timestamp beside it would be a
second way of saying the same thing that could drift from the first. This is
the same reasoning as the fapiao push's own bodies, which are an order number
and a sum and no label at all.

**EVERY CONTENT WORD IS LIFTED FROM A LIVE STRING**, checked against the tree:
`明天` (the delivery slot chips' own `Tomorrow` / `明天`, and the day-only
badge), `提醒我` (the push preference `应用关闭时也提醒我`), `提醒` alone (live in
`发送测试提醒`) and `已恢复` in the shape `已` + `恢复` (`整单已恢复待开票`, and
`恢复` is the live word for the 不开发票 undo). The composition is arrangement,
not invention.

**WHY IT HAD TO BE COMPOSED.** Nothing in this product has ever let an operator
defer a notification. The two live phrasings near it are about a push
PREFERENCE — whether alerts arrive at all — and this is the opposite: a
statement about one row, made by somebody who wants the alerts.

### Composed — one arrangement of live words

| where | EN | CN |
|---|---|---|
| the chip on a pending fapiao row, and the toast when it is set | Remind me tomorrow | 明天提醒我 |

### Lifted verbatim — recorded, not composed

| where | EN | CN | from |
|---|---|---|---|
| the toast when a deferral is lifted | Reminder back on | 提醒已恢复 | `提醒` from `发送测试提醒`; `已恢复` from `整单已恢复待开票` |

### Rejected

- **Rejected: `稍后提醒` ("remind me later").** Live nowhere, and it is vaguer
  than the control actually is. This defers to tomorrow's reminder hour and no
  further — "later" would promise a flexibility the column does not have.
- **Rejected: `忽略` / `跳过` ("ignore" / "skip").** Both describe a dismissal,
  which is precisely the thing this control is NOT: a swipe on the banner writes
  nothing and the chase returns on its own schedule. A word that made the two
  sound alike would undo the distinction the whole feature rests on.
- **Rejected: `已推迟` for the set state.** Not live, and made redundant by the
  chip's own fill. See the note above.
- **Rejected: printing the date the deferral reaches.** `明天 10:00` is true and
  is a second source for a fact the button already states.

## Evidence on a late-parcel case (2026-09-11)

One composed pair and four lifted verbatim, for §98's last two open items — the
evidence attached to a carrier claim, and a delay banner that now has to speak
for land and same-city parcels as well as air. Both surfaces
(`public/retail-admin/04-orders.js`, `public/m.html`). Register: **OPERATOR**
(Rule 1). Composed under Rule 4's standing delegation, by Claude Opus 5.

**THE BANNER HEADING WAS RESTRUCTURED RATHER THAN TRIPLED.** Widening the alert
from air-only to every mode needed a heading that fits a land parcel and a
same-city rider, and the obvious route was three pairs — `空运延误` alongside a
new `陆运延误` and `同城配送延误`. Instead the heading became mode-neutral, and
**`配送延误` is already live** inside `配送延误送达`, the customer's own
delayed-delivery notification. One lift in place of two mints, and the parcel's
mode is on the card beside it anyway.

**`添加照片` IS THE ONLY THING COMPOSED**, out of `添加` (live in thirty-six
files) and `照片` (fifteen). `凭证`, `查看` and `删除` are lifted whole from
elsewhere in the admin.

### Composed — an arrangement of two live words

| where | EN | CN |
|---|---|---|
| attaching a photograph to a carrier claim | Add photo | 添加照片 |

### Lifted verbatim — recorded, not composed

| where | EN | CN | from |
|---|---|---|---|
| the delay banner heading, every mode | Delivery delayed | 配送延误 | `配送延误送达`, the customer's `order_air_delayed` notification |
| the evidence row | Evidence | 凭证 | live in seven files |
| opening one photograph | View | 查看 | live in thirty-four files |
| detaching one | Remove | 删除 | live in thirty-five files |

### Rejected

- **Rejected: `陆运延误` and `同城配送延误`.** Both are honest arrangements of
  live words (`陆运` and `同城配送` are the mode labels this product already
  ships) and both were written before being deleted. Three headings for one fact
  is three strings to keep in step, and the card already states which parcel it
  belongs to — the heading did not need to repeat it.
- **Rejected: `附件` for the evidence row.** The natural word for an attachment,
  and live in **zero** files. `凭证` is what this product already calls a
  document kept as proof.
- **Rejected: a pair for the size refusal on the desktop** ("that photo is too
  large"). It is composed here rather than in the catalogue because it is a
  client-side guard on a number this screen chooses, not a code the server can
  send; putting it in `01-core.js`'s error map would imply the server has a
  refusal it does not have.

## Naming the channel a conversion rate belongs to (2026-09-11)

One pair lifted whole and two arrangements of live strings, for §100 — the phone
card and the desktop cells that had been dividing every channel's orders by one
channel's sessions. `public/m.html`, `public/retail-admin/03-dashboard.js`.
Register: **OPERATOR** (Rule 1). Arranged under Rule 4's standing delegation, by
Claude Opus 5.

**NOTHING WAS MINTED, AND THE REASON IS THAT THE WORD WAS ALREADY ON THIS
PHONE.** The Orders screen's channel chips have shipped `Mini app · 小程序`
against the `wechat` channel since they were built — the same channel, the same
population, one tab across from the card being labelled. Lifting it also keeps
the two screens agreeing about what the word covers, which a synonym would have
quietly broken: `微信小程序` and `小程序端` were both available and both would
have read as a second, slightly different channel.

**THE TWO ARRANGEMENTS PUT THAT LIFT BESIDE STRINGS THE SAME CARD ALREADY
SHIPS.** `转化率`, `单 ÷` and `次会话` are live in the phone's own conversion
cell; the desktop's label and sub-line now carry the channel in front of them
rather than inventing a way to say it.

### Lifted verbatim — recorded, not composed

| where | EN | CN | from |
|---|---|---|---|
| the heading over Home's second card | Mini app | 小程序 | the Orders screen's channel chip for the same channel, `public/m.html` |

### Arrangements — live strings placed together, no new word

| where | EN | CN |
|---|---|---|
| the desktop KPI card's label | Conversion (mini app) | 转化率（小程序） |
| its sub-line, the channel already named above it | N orders ÷ M sessions | N 单 ÷ M 次会话 |
| the Customers card's sub-line, which has no such label | N mini-app orders ÷ M sessions | N 单（小程序）÷ M 次会话 |
| the same cell below its small-denominator threshold | N mini-app orders from M sessions | M 次会话中 N 单（小程序） |
| the money-path funnel's first row | Visited the mini app | 小程序浏览 |
| its second | Ordered in the mini app | 小程序下单 |

### Rejected

- **Rejected: `小程序订单` as one compound.** The natural reading of "mini-app
  order" and live in **zero** files. The parenthetical keeps `单` and `小程序`
  as the two live strings they already are, which is also what lets the phone
  and the desktop stay word-for-word the same.
- **Rejected: `微信小程序` for the card heading.** Live, and more formal than
  the chip — but the chip is what this operator taps to filter these same
  orders, and two names for one channel on two screens is the confusion the
  label exists to end.
- **Rejected: restructuring the card to need no heading at all.** Preferred by
  Rule 4 and genuinely tried: the four cells could each have carried the channel
  in their own sub-line. Four repetitions of one fact, and the fact belongs to
  the card rather than to any cell in it.
- **Rejected: leaving `到店浏览` on the funnel's first row.** "Visited the
  store" is true of a Meituan customer too, and the row counts a denominator
  only the mini app produces — which is the §100 fault in miniature.

## The hour the kitchen's own request is raised (2026-09-11)

§101. The night's `awaiting_restock` pre-orders now raise one kitchen request in
the morning, so the push and the printer carry them. **NOTHING IS MINTED FOR THE
REQUEST ITSELF**, and that is worth stating before the table: the row is
`purpose='order'`, so the queue draws *For an order · 用于发货* and the slip
prints `厨房新请求` above it — every one of those strings already live, reached
unchanged. The request's note is `有客户订单等待`, lifted verbatim from §84's own
block on the same screen, where it already means exactly this.

What is new is a settings control, and only because Ash chose a per-tenant hour
over a fixed one. Two strings, both arrangements of live fragments.

### Lifted verbatim — recorded, not composed

| where | EN | CN | from |
|---|---|---|---|
| the auto-raised request's note | Customer orders waiting | 有客户订单等待 | §84's owed block, `public/m.html` `kqOwed` — and the kitchen-request purpose picker it was lifted from originally |

### Arrangements — live strings placed together, no new word

| where | EN | CN |
|---|---|---|
| the settings row's label | Morning request hour | 厨房制作请求时间 |
| its description | One request a day for what customers have already ordered and the shelf does not have. It pushes and prints like any kitchen request. Leave blank to turn it off. | 每天一张厨房制作请求,数量取自有客户订单等待的商品,与其他制作请求一样推送并打印。留空则关闭。 |

`厨房制作请求` is live **whole** in `routes/restock.js` — *"This is a transfer
between locations, not a kitchen request · 这是门店之间的调拨,不是厨房制作请求。"*
— three times over, and it is the phrase this feature is named after rather than
a compound built for it. `时间` rides in `前一晚锁定时间` two rows above the new
one on the same settings panel. `每天` is the low-stock digest's own opener
(`每天发送库存偏低清单`), `留空则关闭` the pattern of `留空则使用全店默认值` and
`留空则一直显示,直到你停用它`, and `有客户订单等待` is the lift declared above,
reused inside the sentence so the setting and the block it drives read as one
thing.

**THE SECOND CLAUSE EARNS ITS PLACE BY SAYING WHAT THE SETTING DOES, and every
word of it is live too**: `推送` (57 files) and `打印` (91) are this product's own
words for the two things Ash asked for — `推送通知` on the notification rows of
this very screen, `自动打印` on the receipt rows below them — and `与…一样` rides
in eight places already. It is there because an hour field alone does not tell an
operator that setting it starts a push and a slip, which is the whole feature.

**THE COMMA IS HALF-WIDTH**, matching this file's own body and the 202 CJK
half-width commas in `public/retail-admin.html` against 12 full-width. Not a
preference: a string declared here and shipped there must be byte-identical or
this document stops being the lock it claims to be.

### Rejected

- **Rejected: `自动制作请求时间` — "auto request hour".** The obvious label, and
  `自动` is live in 251 places. Dropped because **the operator does not need to
  be told it is automatic** — it is a settings field with an hour in it, which
  is what automatic looks like — and because naming it *auto* invites the reading
  that there is also a manual version of this same request, which there is not:
  the manual one is the picker on the phone and it has its own name.
- **Rejected: `厨房下单时间`.** Shorter and reads well, but `下单` is the
  customer placing an order everywhere else in this vocabulary, and borrowing it
  for the kitchen being asked to cook is the one confusion this whole section is
  about.
- **Rejected: restructuring so no label was needed at all.** Preferred by Rule 4
  and genuinely tried — the row could have sat unlabelled under the existing
  *Order-by hour* as a second number. Two bare hour fields in a column, one
  meaning "stop taking orders" and the other "tell the kitchen", is worse than
  one composed label.
- **Rejected: naming the batch in the description (`今天这批`).** The hour is not
  tied to a batch day: `lib/batch-owed.js` knows no cadence and the units are
  owed whether or not the kitchen is cooking today — §84's own reason for
  refusing to say *today's batch* in the heading, and it holds here.
## When pre-orders open — the batch schedule card (2026-09-11)

§102 gives the pre-order window a START the tenant can set, beside the cut-off
§85 already gave them. One row, one new pair.

### Composed

| key | EN | CN | provenance |
|---|---|---|---|
| `preorderOpenHour` | Pre-order opens | 预订开始 | **COMPOSED** under Rule 4's standing delegation, 2026-09-11, by Claude Opus 5 |

**Register: OPERATOR** (Rule 1) — it labels a field in Mini App Backend →
Delivery → Fresh batch schedule, read only by whoever sets the cadence.

**BOTH HALVES ARE ALREADY ON THIS SCREEN, WHICH IS WHY IT IS AN ARRANGEMENT
RATHER THAN A MINT.** `预订` is live twice in the same card — `预订截单`
(Pre-order cut-off) and `预订可售数量` (How many to offer), both locked by §85
— and `开始` is live as `同步开始` (*"Sync starts"*), the per-store field in
Settings → Ops that governs the very gate this row now widens. The operator has
already learned both words on the two screens this setting sits between.

**LIVE CANDIDATES CONSIDERED AND REJECTED, recorded so the search is not
repeated.** **`预订开始时间`** — correct and unambiguous, and rejected because
the row already carries a `:00` unit suffix and every sibling hour in the card
(`厨房已完成`, `预订截单`) names the event rather than the time of it; adding
时间 to one of four would make the other three read as something else.
**`开始预订`** — the verb phrase, which reads as a button the operator presses
rather than a clock they set, and this control is a number field.

**THE PAIR IT MUST SIT BESIDE IS `预订截单`**, and the two are deliberately
asymmetric in English — *opens* / *cut-off* — because that is how the card's
other hours read. The Chinese keeps the same shape: `开始` against `截单`.

**Ash should correct this if it reads wrong to a Chinese operator; nothing
depends on the exact phrasing.**

## Which items a channel holds a wrong number for (2026-09-11)

§103. One page, one dashboard row and one phone screen that say, per item and
per channel, whether Meituan, Eleme and GZ Grocery hold the number we would
send them. **EVERY STATE AND EVERY REASON IS A LIVE PAIR LIFTED WHOLE** from the
Meituan and Eleme tabs, so a fact reads the same here as it does where it gets
fixed. What is new is the page's own name, and two shapes built from live words.

### Lifted verbatim — recorded, not composed

| where | EN | CN | from |
|---|---|---|---|
| state | Synced | 已同步 | Meituan and Eleme tabs |
| state | Needs attention | 待处理 | Meituan and Eleme tabs (chip, tile, status line) |
| state | Sync off | 已关闭 | Meituan tab |
| state | Not listed | 未上架 | Products / Shops (`已上架 / 未上架`) — and now the Eleme tab's own, §103 step 5 |
| reason | Listing not found | 找不到该商品 | Eleme tab |
| reason | No option picked | 未选规格 | Eleme tab |
| reason | No listing name | 缺商品名 | Eleme tab |
| reason | Add name | 待填名称 | Meituan tab |
| reason | Store not connected | 门店未关联 | Eleme tab |
| reason | Sending… | 发送中… | Orders, Marketing, the phone |
| reason | Push failed | 推送失败 | Meituan tab toast |
| reason | never synced | 从未同步 | `lib/meituan-drift-sweep.js` alert line |
| channel card | Not syncing since … | 自 … 起未同步 | Dashboard's stall row (`未同步`, `自 … 起`) |
| channel card | N stock updates waiting | N 条库存更新等待中 | Dashboard's stall row |
| channel card | N listings read | 已读取 N 个商品 | Eleme store line |
| status line | N synced · N need attention · N not listed | N 个已同步 · N 个待处理 · N 个未上架 | Eleme status line, shape and words |
| empty state | Nothing needs you. | 无需处理。 | Meituan and Eleme status lines |
| dashboard cta | Open channel | 前往渠道 | Dashboard |

### Arrangements — live strings placed together, no new word

| where | EN | CN | from |
|---|---|---|---|
| the fix button, per channel | Open Meituan / Open Eleme / Open GZ Grocery | 前往美团 / 前往饿了么 / 前往 GZ Grocery | `前往` from the dashboard's eight `前往…` CTAs; the channel names from the Sales cards |
| the dashboard row's CTA | See items | 查看商品 | `查看` from the phone's `查看美团订单`; `商品` everywhere |
| the last chip | All items | 全部商品 | `全部` from `全部门店`; `商品` everywhere |

### Composed — declared, by Claude Fable 5.1, under Rule 4's 2026-09-06 delegation

| where | EN | CN |
|---|---|---|
| the page, the tab, the dashboard row's label, the phone screen and its More row | Channel sync | 渠道同步 |

`渠道` is live in `前往渠道`, `渠道与配送` and the Sales cards; `同步` is live in
`已同步`, `未同步` and `同步开始`. The compound is the plain noun for a page that
is about all three channels' sync at once, and nothing live names that.

### Rejected

- **Rejected: `渠道商品待处理` — "items need attention on a channel", for the
  dashboard row.** Drafted for the mockup and dropped: restructuring the row to
  carry the page's own name as its label, with the tabs' live `N 个待处理`
  shape as its state line, left nothing to compose. Rule 4's first preference.
- **Rejected: `到美团页修复` — "fix on the Meituan tab", for the button.**
  Drafted for the mockup. `前往` + the channel name says the same thing in
  words the operator already reads on the dashboard eight times over.
- **Rejected: `未核对` for the unread-catalogue state.** The Meituan and Eleme
  tabs deliberately hold this one in English on both sides (`MT_PENDING_CN` /
  `EL_PENDING_CN`, *Name not checked*) until Ash sources the Chinese; this page
  does the same rather than mint a word the tabs would then not share.
- **Rejected: `同步状态` — "sync status".** Reads as a settings field, and the
  page is not a status readout but a list of what to do.

## Why a push failed (2026-09-12)

§105. A stock push that fails now says the cause instead of *transient push
failure — retries exhausted*. The cause was always computed; it was discarded
between the browser layer and the daemon. Nothing here is composed.

### Lifted verbatim — recorded, not composed

| where | EN | CN | from |
|---|---|---|---|
| cannot reach | Cannot reach the sync service. | 无法连接同步服务。 | Meituan tab, `mtRenderHead` |
| signed out | … is signed out | 已退出登录 | Meituan and Eleme tabs, block text |
| sign in | Sign in again | 重新登录 | Meituan tab's re-auth button |
| name | Listing not found. | 找不到该商品。 | Eleme tab |
| unread | The listing could not be read. | 尚未读取商品。 | Eleme store line |
| gave up | Tried several times and gave up. | 多次重试仍失败。 | both daemons' `logSync` |

### Arrangements — live strings placed together, no new word

| where | EN | CN | from |
|---|---|---|---|
| the platform refused | Meituan returned: … | 美团返回：… | `微信支付未通过校验。微信返回：` — the live shape for a platform's own error, with the channel's name |
| signed out, with the fix | The sync service is signed out of Meituan. Sign in again. | 同步服务已退出登录美团。请重新登录。 | `已退出登录` + `重新登录`, joined by the live `请重新…` shape (`请重新搜索`, `请重新打开订单`) |
| the option went | The option this product is mapped to is no longer on the listing. Pick it again. | 找不到该规格，请重新选择。 | `找不到该商品` with `规格` (live, `未选规格`), plus `请重新…` and `选择` (live, `请从列表中选择商品名`) |

An HTTP status needs no label at all — `无法连接同步服务（HTTP 502）` is the
lifted pair with a numeral, which is Rule 4's own first preference.

### Rejected

- **Rejected: translating Meituan's `msg`.** It is the platform's own sentence
  about its own refusal. Anything we wrote in its place would be less accurate,
  and would go stale the moment Meituan changed a message.
- **Rejected: `同步失败原因` as a heading for the line.** The line already sits
  under *the last push failed*; a heading saying "reason for sync failure" above
  a reason is a label for a label.
- **Rejected: minting Chinese for an uncategorised failure.** It comes back with
  the raw text and the live `推送失败` prefix. A sentence we invented for a cause
  we have not seen would be a guess wearing a translation.

## What is stopping the whole channel (2026-09-12)

§106. A channel that cannot push says so once, on its own card, with the cause
its daemon recorded — a captcha waiting for a human, a signed-out session, a
proxy that cannot reach the platform, a queue that stopped draining. An item
whose own failure is one of the generic ones defers to it.

### Lifted verbatim — recorded, not composed

| where | EN | CN | from |
|---|---|---|---|
| captcha | … is asking for a captcha — a human has to pass it on the sync machine. Sync is paused. | 验证中心风控，同步已暂停，需要人工验证。 | `scripts/meituan-daemon.js` — the daemon's OWN merchant alert, verbatim |
| stopped going out | Stock updates stopped going out. | 同步已停。 | Eleme tab, `EL_BLOCK_TXT` fallback |
| since | since | 自 | Orders page, `04-orders.js` |

The sign-in sentence (`同步服务已退出登录…请重新登录。`) is §105's own arrangement,
reused unchanged for a channel-level signed-out session. Eleme's `auth_required`
and Meituan's `needs_login` are the same fault under two daemons' names and take
the one sentence.

### Composed — declared, by Claude Opus 5, under Rule 4's 2026-09-06 delegation

| where | EN | CN |
|---|---|---|
| cannot reach, and so it stopped | Cannot reach the sync service. Sync is paused. | 无法连接同步服务。同步已暂停。 |

**Two live sentences joined, and nothing else.** `无法连接同步服务` is the
Meituan tab's own (locked above, §105); `同步已暂停` is the second clause of the
daemon's own captcha alert, lifted whole from the line directly above it in this
same section. The join is a full stop.

**Why a new string at all, when Rule 4 prefers restructuring the label:** the
existing pair says only that we cannot reach the service, which on an ITEM row
is the whole story and on a CHANNEL card is half of it — the operator's next
question is whether anything is still going out, and the answer is no. The
clause that answers it was already written by the daemon for the neighbouring
fault.

**Candidates considered and rejected:**

- **`无法连接同步服务。` alone** (the locked pair, unchanged) — the first
  preference under Rule 4 and rejected only because a channel card that says
  what cannot be reached without saying what has stopped leaves the operator to
  infer the consequence. On the item row it is still exactly what is used.
- **`代理不可用` / `代理已断开`** — accurate about `proxy_down` and wrong for the
  reader: `代理` is our word for our own infrastructure, and no tenant-facing
  string in this document has ever named it. The operator cannot act on which
  hop failed.
- **`无法连接同步服务，同步已暂停。`** with a comma rather than a full stop — the
  daemon's own alert uses commas throughout one continuous clause; two
  independent sentences read as one run-on. Rejected on punctuation only.
- **`同步服务连接失败。同步已暂停。`** — `连接失败` is not live anywhere in the
  admin, and it would mint a second way of saying `无法连接` that already exists.

## Naming both counts on the stall card (2026-09-12)

§107. Asked by Ash, from the phone's Channel sync screen showing *"Meituan
stopped taking stock updates — 3 stock updates waiting since Sep 7"* directly
above a Needs attention list holding only 2 items — the same divergence §104
already ruled on for Home (`channel_items_attention.count` counts PRODUCTS,
`channelSyncStale().waiting_count` counts (store, product) push TARGETS, and
the two are never summed), now read as a mismatch on the one screen that
shows both numbers side by side. The stall line on the Channel sync page
(desktop `29-channel-sync.js`'s `strip()`, phone `m.html`'s new
`csStaleLine`) now names the item count beside the push-target count it
already had, so the gap is explained rather than read as wrong. Nothing about
`lib/channel-sync-stale.js` or `lib/channel-sync-items.js` changes; both
counts are read exactly as before.

### Lifted verbatim — recorded, not composed

| where | EN | CN | from |
|---|---|---|---|
| desktop's added clause | N need attention. | N 个待处理。 | `29-channel-sync.js`'s own non-stale branch, same file, three lines below |

### Composed — declared, by Claude Sonnet 5, under Rule 4's 2026-09-06 delegation

| where | EN | CN |
|---|---|---|
| phone's added clause, per stalled channel | N item(s) need attention. | N 件商品待处理。 |

**Two live fragments joined, nothing else.** `件商品` is the phone's own
noun for a count of products (the neighbouring "every channel is in step"
card on this same screen: `"N 件商品。无需处理。"`); `待处理` is the phone's own
word for the `att` state (`csWord`'s "Needs attention" chip). The phone has
no sentence-shaped "N need attention" the way the desktop status line does,
so the two nouns are joined directly rather than borrowed as a finished
sentence.

**Candidates considered and rejected:**

- **Reusing the desktop's `N 个待处理` verbatim on the phone.** Rejected: `个`
  is not this screen's counter for a product on the phone — every other count
  on this exact card and its sibling (`"N 件商品。无需处理。"`) counts in `件`,
  and switching counters mid-screen for one clause would read as a second
  voice.
- **`涉及 N 件商品`** — "involving N items", after `02-settings-ops.js`'s
  `N 项涉及资金`. Rejected: `涉及` names a relationship between the stall and
  the items that the sentence does not need — `件商品待处理` says the same fact
  in fewer characters, from words already live on this exact card.
- **Leaving the phone card unchanged and fixing only the desktop.** Rejected:
  the screenshot that prompted this was the phone.

## The add toast for a meal not yet made (2026-09-13)

§108. Ash ruled that a sold-out fresh meal reads `NEXT BATCH · 下批现做` to
every shopper, Guangzhou or not — the wait is the same fact wherever they are,
and only the DATE differs, which the checkout notice states. Every badge, pill
and button moved. **The add toast was the last surface that had not**: it fired
`已预订，加入购物车` / *Added — pre-order* for any reservable row, so a customer
who tapped a button reading NEXT BATCH was answered with the word §108 had just
taken off that button. Five toast sites, four files
(`miniapp/pages/shop/shop.js`, `miniapp/pages/product/product.js`,
`miniapp/pages/favorites/favorites.js`, `public/shop.html`), all now reading the
same `kind` verdict their own badge reads.

### Unchanged — recorded because it is deliberate

| where | EN | CN | why it stays |
|---|---|---|---|
| add toast, sold-out GROCERY row | Added — pre-order | 已预订，加入购物车 | Nothing is being cooked for a bag of rice. §108's carve-out: "next batch" would name a thing that does not exist, and this is still the honest word for a restock we have no date for. |
| add toast, ordinary in-stock row | Added to cart | 已加入购物车 | Untouched. It is also one of the two fragments the new line is built from. |

### Composed — declared, by Claude Opus 5, under Rule 4's 2026-09-06 delegation

| where | EN | CN |
|---|---|---|
| add toast, a fresh meal the kitchen has yet to make | Added — next batch | 已加入购物车，下批现做 |

**Two live fragments, joined in the shape the sentence beside it already uses.**
`已加入购物车` is this app's own plain add toast — the other branch of the very
same `if`, in all four files. `下批现做` is the locked NEXT BATCH badge, and the
point of the change is that it is the word the customer just tapped. The comma
is not a choice either: the pre-order toast it sits beside is
`已预订，加入购物车`, two clauses joined by `，`, and this follows it.

**Order matters and was chosen.** Confirmation first, wait second —
`已加入购物车` then `下批现做`. A toast's first job is to tell the customer the
tap worked.

**Candidates considered and rejected:**

- **Keeping `已预订，加入购物车`.** Rejected: it is the exact mismatch §108
  exists to end — the customer reads `下批现做` on the button and `已预订` a
  second later, for one meal.
- **`下批现做，已加入购物车`** — the pre-order toast's own clause order, state
  first then confirmation. Rejected: it fronts the wait ahead of the thing the
  customer actually did. The existing toast can lead with `已预订` because a
  reservation IS the action; here the action is an ordinary add and the batch is
  the note attached to it.
- **`已加入购物车 · 下批现做`** — the two fragments with a middot. Rejected: `·`
  is this app's badge and label separator (it is how this document writes
  `NEXT BATCH · 下批现做`), not a sentence connector. The comma is what the
  neighbouring toast uses in running text.
- **`已加入购物车，下一批现做`** — the checkout notice's kicker, `下一批现做`,
  instead of the badge's `下批现做`. Rejected: the customer just tapped a button
  reading `下批现做`; echoing that exact string is the whole point, and the
  notice's longer form belongs to the notice.

## The verdict that had no Chinese half (2026-09-13)

Channel sync has five verdicts. Four of them shipped bilingual — `已同步`,
`待处理`, `已关闭`, `未上架` — and the fifth, `unk`, shipped as
`['Name not checked', 'Name not checked']`: English on both sides, reaching a
Chinese reader in English on three surfaces at once. The desktop's shared
`CH_STATE_WORD` (`01-core.js`), the Products page's channel dots
(`09-products.js`), and the phone's `csWord` (`m.html`).

It was not an oversight, and `01-core.js` said so in a comment: `unk` was held
English deliberately, as the placeholder the Meituan and Eleme tabs already
carry (`MT_PENDING_CN` / `EL_PENDING_CN`), *"while Ash sources the Chinese"*.
**That default is the one Rule 4's 2026-09-06 amendment repealed** — the
Chinese is delegated now — so the placeholder had outlived its own reason and
was still shipping.

**Nothing is minted for it.** `unk` is not really a verdict: per
`lib/channel-sync-items.js`, it means the item IS mapped, but the store's
catalogue has never been read, so the name cannot be checked either way — one
fact about the STORE, drawn neutral, never amber. The Channel sync page has
been stating that exact fact in Chinese on its own store lines for as long as
it has existed.

### Lifted verbatim — recorded, not composed

| where | EN | CN | from |
|---|---|---|---|
| the `unk` verdict word, all three surfaces | Name not checked | 尚未读取商品 | `29-channel-sync.js`'s store line — the same page, one panel up, where a store whose catalogue has never been read already reads `尚未读取商品` |

**The English half is the one already shipped, not the source pair's.** On the
store line the live pair is *no listings read yet* / `尚未读取商品`. Only the
Chinese half moves here; it is re-paired with the verdict word's existing
English rather than replacing it, because *Name not checked* is what five
files and two surfaces already say and this entry exists to close a gap, not
to re-word a shipped verdict. The two halves name the same fact from
different ends — the cause (the catalogue was never read) and its consequence
(so the name is unchecked) — which is what the state is.

It also sits right for the slot: the cell word renders beside
`找不到该商品` (6), `门店未关联` (5) and `未选规格` (4), so six characters is
the established shape, not an outlier.

### Rejected

- **`尚未核对名称`** — "the name has not been checked yet", a literal read of
  the English. Rejected on Rule 4's own order of preference: a live string
  states this fact on this very page, so composing a second way to say it
  would put two phrasings of one state in one product for no gain.
- **Eleme's live `尚未读取商品目录，无法匹配`** — "the catalogue has not been
  read, so nothing can be matched" (`14-eleme.js`), which carries the whole
  semantic including the consequence. Rejected on shape: this slot is a
  verdict WORD standing beside four others, and a twelve-character clause
  with a comma in it would not read as one of a set of five.
- **Restructuring the English to the source pair's own *No listings read
  yet*, so the live pair transfers whole.** This is the move CLAUDE.md
  prefers — restructure the label rather than mint a string — and it is
  rejected only because nothing is being minted here either way: taking it
  would mean rewriting shipped English across five files and two surfaces to
  avoid supplying one Chinese half, which is the larger change of the two.
- **Leaving it English, as `01-core.js` intended.** Rejected: that comment
  predates the 2026-09-06 amendment and is the default it repealed. Waiting
  is no longer the instruction.
- **Filling `MT_PENDING_CN` / `EL_PENDING_CN` at the same time.** Rejected as
  a different job: those are whole sets of ~15 English strings each
  (`catNever`, `catLabel`, `catRefresh`, `catFailed`, …), still English on
  both sides, and they remain so. This entry covers the verdict word only.

## Payment and delivery — three untaught tender words on Reports (2026-09-13)

Reports → Sales → **Payment and delivery** bars its revenue by
`retail_orders.payment_method`, through a lookup in `dashRenderSplits`
(`03-dashboard.js`). The lookup was missing three real values, and an unmapped
key there returns the raw key itself, unpaired — `meituan`, `eleme` and
`offline` were surfacing as bare English words next to properly bilingual
rows like `WeChat Pay · 微信支付`, on both languages, because a string with no
` · ` in it is not bilingual text the i18n walker can toggle.

`meituan` and `eleme` are not new vocabulary — they are the literal
`payment_method` a Meituan or Eleme channel order is written with
(`routes/meituan-internal.js:474`, `routes/eleme-internal.js:580`): money that
settled on that platform, never touching our own gateways. `offline` is the
pre-existing generic tender in `routes/retail.js`'s `ALLOWED_PAY`, the
catch-all a counter payment falls back to when it isn't tied to one of the
five specific off-app wallets (`cash`, `bank_transfer`, `wechat_offline`,
`alipay_offline`, `other`) below it.

### Lifted verbatim — recorded, not composed

| key | EN | CN | from |
|---|---|---|---|
| `meituan` | Meituan | 美团 | this same file's `DASH_CHAN_SHORT` (`03-dashboard.js:974`) and `CH` (`:3125`) |
| `eleme` | Eleme | 饿了么 | this same file's `CH` (`03-dashboard.js:3125`) |

### Composed — `offline`

**THE PAIR — composed by Claude, 2026-09-13, under the 2026-09-06 delegation.**

| key | EN | CN | What it says |
|---|---|---|---|
| `offline` | Offline | 线下 | Revenue bucket for the generic counter tender — paid outside the app, no specific wallet recorded. |

The Chinese half is not new characters: `线下` is the live fragment already
standing inside the two locked pairs one row above it in the same map,
`WeChat off-app · 微信(线下)` and `Alipay off-app · 支付宝(线下)`. This entry
just gives that fragment its own bar for the one payment_method value that
predates those two and carries no wallet name to go with it.

### Rejected

- **`Other · 其他`.** `other` is already a distinct `payment_method` value one
  slot over in the same map. Reusing its Chinese for `offline` would put two
  different revenue buckets under one label, which is the exact defect this
  fix exists to close.
- **`Counter · 柜台` / reusing `Counter sale · 前台销售`** (`till.html`).
  `offline` names how the money was taken, not which sales channel it came
  through — a counter sale can be paid by any wallet, and a delivery order can
  be marked paid `offline`. Borrowing the counter-sale word would conflate the
  two.

## Was this ordered from a supplier? — the Transactions form (2026-09-13)

The one question `public/retail-admin/22-finance.js` gained under
`docs/tacet-consolidation-decisions.md` §111 part two, with the settings control that takes
its answer back. Register: OPERATOR (Rule 1) — the person recording what the business spent.

**Nothing here is a new word.** Every Chinese term in the six composed strings is lifted from
a pair already live in this product, and four of the six come off this very screen. What is
composed is the arrangement, because no screen in this product has ever asked an operator
which of two records a cost belongs in.

### Taken verbatim (no new Chinese)

`Continue · 继续` and `Cancel · 取消` — the dialog's two buttons. Both are already live in
`22-finance.js` itself.

### The live terms these are built from

| term | the live pair it comes off | where |
|---|---|---|
| `采购单` | `Open purchase order · 查看采购单` | `22-finance.js`, this screen |
| `记入` | `Posted by Purchasing · 采购单自动记入` | `22-finance.js`, this screen |
| `支出` | `Money out · 支出` | `22-finance.js`, this screen |
| `财务` | `Could not load Finance. · 财务数据加载失败。` | `22-finance.js`, this screen |
| `供应商` | `Choose supplier · 选择供应商` | `16-purchasing.js` |
| `下单` | `Place order · 确认下单` | `16-purchasing.js` |

### Composed

| where | EN | CN |
|---|---|---|
| the question | Was this ordered from a supplier? | 这笔是向供应商采购的吗？ |
| under it | A purchase order reaches Finance when you place it. | 采购单下单后才会记入财务。 |
| first answer | Put it on a purchase order | 记入采购单 |
| second answer | Record it as an expense | 记入支出 |
| the toast, for a category already answered | This goes on a purchase order | 该笔记入采购单 |
| the settings checkbox | Ordered from a supplier | 向供应商采购 |

**THE TWO ANSWERS ARE DELIBERATELY THE SAME SHAPE.** `记入采购单` and `记入支出` differ in
exactly one word — where the cost goes — because that is the only thing the operator is being
asked to decide. An asymmetric pair would read as one real option and one way out.

**The sentence under the question is a disclosure, not a reassurance, and it is the honest
half of this change.** A typed row is in the books the moment it is saved; a purchase order
posts nothing until somebody places it. So choosing the purchase order moves that money out
of the month's figures until the order goes out, and the operator is told so in the same
breath as being asked. `下单后才会` — *not until it is placed* — is the whole point of the
line; a softer wording would be the screen declining to say what it does.

**The toast fires only where the question does NOT.** A category already answered *ordered*
is not asked again — that is what the answer is for — so the screen changes under the
operator with nothing said. `该笔记入采购单` is what says it, in the same two words the
answer they once gave was written in.

### Rejected

- **`采购 · Purchase` alone for the settings label.** It names the activity, not the fact
  being flagged. The checkbox answers *is what is filed here bought from a supplier*, and
  `向供应商采购` is that sentence; `采购` on its own would read as a category of spending,
  which is exactly what it is not.
- **`这一行向谁采购？`** (`16-purchasing.js`, the line's supplier picker). Considered for the
  question, and rejected: it asks WHICH supplier, taking for granted the very thing being
  asked here. Its `采购` is the term that was taken; its sentence is a different question.
- **`采购单自动记入`, whole, as the toast.** It is the live pair the term `记入` comes from and
  it very nearly fits — but it describes what Purchasing does to the books automatically, on
  a row that is already there. Said to somebody who has just been moved to another screen it
  would be describing the wrong end of the journey.
- **`是 / 否` prefixes on the two answers.** Dropped rather than translated: the answers are
  already self-describing, and a Yes/No in front of them would make the pair read as a
  question about agreement rather than a choice between two records.

Ash should correct any of this if it reads wrong to a Chinese operator; nothing depends on
the exact phrasing.

## Managing permissions from the phone (2026-09-13)

§112 put the whole of Settings → Team on `public/m.html` — the roster, one
person, their permission matrix, the roles behind them, and adding somebody.
The phone had four sentences about Team before this and needed a screen's worth
of them.

**134 bilingual pairs, and 96 of them were already live.** Every label the
desktop's own Team tab and Roles pane ship — `固定角色 — 不可更改`,
`此处的每项更改都会在他们下次打开页面时生效。`, `无例外 — 该成员的权限与角色完全一致。`,
`额外` / `移除`, `涉及资金` / `显示金额`, `仅可使用“加库存”应用`, `拥有仪表盘`,
`恢复为该看板的默认设置`, `新角色的名称`, `会计、周末店员…`, `当前无人使用该角色，删除不会影响任何人。`
— is used **verbatim** rather than reworded for a smaller screen. Two surfaces
saying the same thing two ways is how a shop ends up unsure whether they are
the same setting. Four more were lifted after the first draft had composed
around them: `重置密码` and `新密码(至少 10 位)` (the desktop's own reset button
and prompt), `自定义` (the roster's chip for somebody who stands apart from
their role) and `用户名仅限字母、数字和 . _ -` (the route's own refusal,
`routes/backend-team.js`).

### Arrangements of live sentences — recorded, not composed

Four sentences exist on the desktop and say *where a thing is* as part of what
they say. The phone is the other place, so the clause moves and nothing else
does.

| Live (desktop) | On the phone | What changed |
|---|---|---|
| `若要让该角色使用其他功能,请先在上方“成员”中开启权限强制执行,否则…` | `…请先在“成员”中开启权限强制执行,否则…` | `上方` dropped: enforcement is a tab away here, not above |
| `开启后:仪表盘是该角色在电脑上的首屏,也是手机上的“首页”标签。` | `开启后:仪表盘是该角色在手机上的“首页”标签,也是电脑上的首屏。` | the two devices swap order — you are holding the first one |
| `关闭后:该角色在任何设备上都没有仪表盘。电脑和手机都会打开…` | `关闭后:该角色在任何设备上都没有仪表盘。手机和电脑都会打开…` | same swap; the trailing sentence about the ticks below is dropped, because on the phone they are not below, they are on the next screen |
| `角色仅影响界面显示，服务端尚未强制执行 — 该开关在电脑端。` (the phone's own, until now) | `…服务端尚未强制执行。` and `…— 仅负责人可开启。` | the switch is here now; the clause naming the desktop is replaced by the one rule that still holds — only the owner may move it |

### Composed — thirty-eight pairs

**Composed by Claude, 2026-09-13, under Rule 4's 2026-09-06 delegation.** Every
Chinese character below is already in service somewhere in this product; what
is new is the arrangement.

| CN | EN | What it says |
|---|---|---|
| `强制执行权限` | Enforce permissions | The switch itself. `强制执行` is the desktop's own word for this setting (`开启强制权限？`, and the route's `强制执行`); `权限` is the noun it governs |
| `服务端会拒绝角色权限之外的操作。您始终保留完整权限。` | The server refuses what a role does not allow. You always keep full access. | What ON means. Second clause is the desktop confirm's own `您（负责人）始终保留完整权限。` minus the parenthesis |
| `角色仅影响界面显示，服务端尚未强制执行。` | Roles shape what people see, but the server is not enforcing them yet. | What OFF means (see the table above) |
| `角色仅影响界面显示，服务端尚未强制执行 — 仅负责人可开启。` | …— only the owner can switch that on. | The same, for somebody who cannot move it |
| `已开启强制执行` · `已关闭强制执行` | Enforcing permissions · Not enforcing | The two toasts, on the live `已开启` / `已关闭` shape |
| `添加成员及更改其权限需要管理团队的权限。` | Adding somebody, and changing what they reach, needs permission to manage the team. | What is missing, on the roster |
| `更改这些设置需要管理团队的权限。` | Changing any of this needs permission to manage the team. | The same, on one person's screen |
| `修改角色权限需要设置权限的许可。` | Changing what a role reaches needs permission to set permissions. | The other capability, on the roles list |
| `设置成员权限需要“设置权限”的许可。` | Setting one person’s permissions needs permission to set permissions. | The same, on one person's screen |
| `修改此项需要“设置权限”的许可。` | Changing this needs permission to set permissions. | The same, on the matrix |
| `其他拥有“设置权限”许可的成员可以修改你的权限。` | Somebody else with permission to set permissions can change yours. | Why your own matrix is read-only — the server's rule, said as a fact rather than a refusal |
| `角色决定成员的权限。修改角色后，使用该角色的成员随之变更。` | A role is what a person holds. Change one and everybody on it moves with it. | The roles list's one line |
| `角色是一组权限。可在“角色”中修改其权限，添加后也可为个人设置例外。` | A role is a bundle of permissions… | The same fact, where an invite asks for one |
| `其权限来自所选角色。个人的例外权限在“权限”中设置。` | What they reach comes from the role. Exceptions for this one person are set under Permissions. | The role picker's own sentence |
| `该成员在角色之外的权限差异。` | What this person reaches, on top of their role. | The Permissions row's note |
| `与角色完全一致` | Exactly the role | Its value when there are no exceptions — a trim of the live `该成员的权限与角色完全一致` |
| `关闭后，其所有设备将立即无法登录。` | Switch this off and they are out of every device, at once. | Under the access switch. The live confirm says `此后无法在任何设备登录`; this is the shorter form a switch label can carry |
| `开启后，其角色权限将完全恢复。` | Switch this on and their role comes back exactly as it was. | The other direction, on the live `其角色权限将完全恢复。` |
| `店内对其的称呼。登录用户名不变。` | What the shop calls them. Their username does not change. | Why a display name is not a login |
| `请先输入姓名` | Enter a name first | Its refusal, on the live `请先填写` / `请输入` shape |
| `设置后即可使用新密码登录，原密码立即失效。` | They can sign in with it straight away. Whatever they had stops working. | What resetting a password costs |
| `密码已设置` | Password set | Its toast |
| `角色已更改` | Role changed | The role picker's toast, on the live `已更改` shape |
| `其权限适用于所有门店。` | Everything they can reach, in every store. | What All stores means |
| `仅可见下方勾选的门店。` | They only see the stores ticked below. | What it means switched off |
| `负责人始终拥有完整权限，不可缩减。` | Owner always has full access. It cannot be narrowed. | The matrix's locked footer — the live owner sentence with the desktop's `不可重命名、缩减或删除` reduced to the one verb that applies here |
| `未选择成员。` | Nobody is open. | A person screen with no person — reachable only by a route restored from history |
| `添加成员后即可登录，并按所选角色获得权限。` | Add someone and they can sign in straight away, with the role you give them. | The empty roster, which used to say people are invited on a desktop |
| `暂无可分配的角色 — 请先在“角色”中创建。` | No roles to give yet — make one under Roles first. | An invite form with nothing to give |
| `用户名仅限字母、数字和 . _ -。这是其登录账号。` | Letters, numbers and . _ - only. This is what they sign in with. | The route's own rule, plus the clause that says what a username is for |
| `至少 10 位。添加后会再显示一次。` | At least 10 characters. You will see it once more after they are added. | The password field's hint, on the live `密码至少 10 位` |
| `请把这两项告知对方。密码不会以可读形式保存，无法再次查看。` | Tell them these two. The password is not stored anywhere you can read it again. | The credential receipt. There is no invite email in this product: somebody has to be told |
| `再添加一位` · `返回团队` | Add another · Back to the team | The two ways off that receipt |
| `没有保存成功。未添加成员。` | That did not save. Nobody has been added. | The create's failure, on the live `没有保存成功。数据没有变化。` shape — the second clause names what did not happen |

### Rejected

**`许可` is used for the CAPABILITY and `权限` for what it grants, in exactly
three sentences, and nowhere else.** `修改角色权限需要设置权限的权限` is what the
plain reading produces, and a sentence that ends in the same noun twice reads
as a typo rather than as a rule. The three sentences that name the
`team:permissions` capability itself take `许可`; every other line on these
screens keeps `权限`, which is what the rest of the product says.

**`报错` / `失败` for the create refusal — rejected.** `没有保存成功。未添加成员。`
follows the live pair one clause at a time, and its second clause answers the
question a merchant actually has after a failed invite: whether somebody now
exists half-made.

**A new word for an exception — rejected twice.** `与角色有差异` was composed for
the Permissions row and thrown away in favour of `自定义`, which is the chip the
desktop roster already puts on the same person for the same reason. `差异` and
`不同` are both already in service (`与该角色有 N 处不同`) and a third word for one
idea is how two screens stop describing the same thing.

**Naming the person in the password prompt — rejected.** `新密码 for X` was
composed and dropped: the sheet opens over that person's own screen, which
carries their name in the header, and the desktop's live `新密码(至少 10 位)`
already says the only thing the prompt has to.


## Not arrived yet — the claim that becomes an order (2026-09-13)

The one question `public/m.html`'s expense form gained under
`docs/tacet-consolidation-decisions.md` §113, and the marker the approver's queue gained with
it. Register: OPERATOR (Rule 1) — shop staff on their own phone, and whoever approves what
they send.

**Nothing here is a new word.** Three of the four pairs are arrangements of terms already live
in this product, and the fourth is taken whole.

### Taken verbatim (no new Chinese)

`Open purchase order · 查看采购单` — the link on an approved claim's row. It is already live in
`22-finance.js` for exactly this jump: a ledger row that belongs to a purchase order offers
the same words to reach it. A claim on an order has no ledger row of its own, so this is the
only way to read what it cost, and it should not be a second way of saying the same thing.

### The live terms these are built from

| term | the live pair it comes off | where |
|---|---|---|
| `到货` | `Arrives · 到货` | `16-purchasing.js`, and the phone's own receiving screen |
| `尚未` | `Not on any purchase order yet. · 尚未出现在任何采购单中。` | `18-materials.js` |
| `记入采购单` | `This goes on a purchase order · 该笔记入采购单` | v1.70, §111 part two |
| `门店` | `Shop · 门店` | the expense form itself |

### Composed

| where | EN | CN |
|---|---|---|
| the phone's opt-in | Not arrived yet | 尚未到货 |
| the line under it, when ticked | It goes on a purchase order · the shop tracks it until it arrives | 将记入采购单 · 到货前由门店跟进 |
| the approver's meta line, before deciding | goes on a purchase order | 将记入采购单 |

**THE OPT-IN HAS NO OPPOSITE, AND THAT IS DELIBERATE.** There is no *it has arrived* chip,
because unticked has to go on meaning exactly what this form has always meant — every claim
ever submitted was for goods in hand. A pair of chips would need a default, and a default here
would change what those rows say. (`已到货` IS live one screen over, on receiving, where it
means something else entirely: *N arrived*. The suite counts the commands rather than the
characters so the two cannot be confused.)

**THE SECOND STRING IS THE ONE THAT EARNS ITS KEEP.** Ticking the opt-in makes two optional
fields required — the shop and the description — and a form that started refusing things with
no explanation would be the screen keeping a secret. `将记入采购单 · 到货前由门店跟进` says
what the tick did and why the shop is now being asked for.

**THE APPROVER'S LINE IS THE SAME SENTENCE IN THE FUTURE TENSE, MINUS THE HALF THEY DO NOT
NEED.** `将记入采购单` sits on the meta line beside whose money it was, because approving a
claim normally writes a ledger row and nothing else — an approver who was not told would find
a purchase order in the buying list with no idea where it came from.

### Rejected

- **`在途采购`** (from `Nothing on the way · 暂无在途采购`, the purchasing screen). The best
  candidate considered, and the closest in meaning — *purchases in transit*. Rejected for the
  phone because it names a CATEGORY of orders, which is what that screen's empty state is
  about; the person tapping this chip is saying one thing about one purchase, and `尚未到货`
  is that sentence. Recorded so the search is not repeated.
- **`待收货`** — *awaiting receipt*. Not live anywhere in this product, and it describes the
  shop's side of the transaction rather than the fact the employee is reporting.
- **Reusing the receiving screen's `已到货` inverted.** See the note above: the same characters
  are live one screen over meaning *N arrived*, and borrowing them for a question about one
  purchase would put one phrase on two jobs.

Ash should correct any of this if it reads wrong to a Chinese operator; nothing depends on the
exact phrasing.
