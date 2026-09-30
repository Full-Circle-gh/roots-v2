HEADLINE: THE PHONE'S PRODUCTS, STOCK ACTIVITY AND WASTE LISTS — NOTHING COMPOSED, EVERY LABEL COPIED WHOLE.

## The stock lists' filters and exports on the phone (§NEW)

**Nothing composed, 2026-10-01.** Operator register only (Rule 1): the phone
admin's Products catalogue, Stock activity and Waste screens
(`public/m.html`). Every new label is copied whole from the desktop screen
that does the same thing, or is a pair the phone already uses for the same
control.

From the desktop Products screen (`public/retail-admin.html`,
`public/retail-admin/09-products.js`): `All subcategories · 全部子分类`,
`All stores · 全部门店`, `Going nowhere · 无人问津`, `On promotion · 促销中`,
`Export CSV · 导出`.

From the desktop Stock activity toolbar (`public/retail-admin.html`): the
search placeholder `SKU / name / order · 货号 / 名称 / 订单` and
`Export CSV · 导出`.

The phone's own live pairs, from Finance's and Trend's Custom sheet: `Custom ·
自定义`, `From · 从`, `To · 至`, `Apply · 应用`, `Pick a date · 选日期`,
`From is after to · 起始日期晚于结束日期`. The Custom window's two days are
printed as dates (`fmtDateOnly`), with no label.

Store names, category and subcategory names are the shop's own data, shown in
the language they were entered in, with the tree's Chinese name where it has
one.
