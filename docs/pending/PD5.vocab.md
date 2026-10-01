HEADLINE: A PRODUCT'S DETAILS ON THE PHONE — ONE STRING COMPOSED BY CLAUDE (THE COST TAG'S CHINESE), THE REST COPIED WHOLE FROM THE DESKTOP EDITOR.

## A product's details on the phone (§NEW)

Operator register only (Rule 1): the phone admin's Details screen
(`public/m.html`). Copied whole from the desktop product editor
(`public/retail-admin.html`, `public/retail-admin/09-products.js`,
`01-core.js`):
- **Section and field labels:** `Details · 详情`, `Basics · 基础`, `Name · 名称`,
  `Name (second language) · 名称(第二语言)`, `SKU · 货号`, `Where it shows ·
  分类与陈列`, `Shop section · 商店分区`, `Subcategory · 子分类`, `Badge · 标签`
  and its options (`None · 无`, `Auto · 自动`, `NEW · 新品`, `POP · 热门`,
  `SALE · 特价`, `HOT · 推荐`), `Size / weight · 规格`, `Was price · 划线价`,
  `Stock · 库存`, `Low-stock alert at · 低库存提醒阈值` and its placeholder
  `Default N · 默认 N`.
- **Product details:** `Product details · 产品详情` and the five facts (`Origin ·
  产地`, `Ingredients · 配料`, `Storage · 储存方式`, `Shelf life · 保质期`,
  `Serving suggestion · 食用建议`) with each box's own placeholder, English in
  the English box and Chinese in the Chinese one, as on the desktop.
- **Description:** `Description · 描述`, the toolbar names `Bold · 加粗`,
  `Italic · 斜体`, `Underline · 下划线`, `Bulleted list · 项目符号`, `Numbered
  list · 编号`, `Clear formatting · 清除格式`, and the box labels `English` /
  `中文`, which are data, as on the desktop.
- **Shipping, flags, free-of, notes:** `Shipping · 配送方式`, `Air · 空运`,
  `Land · 陆运`, `Local only · 仅广州`, `Flags · 标记`, `Sold at markets ·
  市集销售`, `Made fresh in batches · 分批现做`, `Restock-only, internal ·
  仅内部补货`, `Free of · 不含`, `Nuts · 无坚果`, `Soy · 无大豆`, `Gluten ·
  无麸质`, `5 Spice · 无五香`, `Internal notes · 内部备注`.
- **Autosave and refusals:** `Add a name to start autosaving · 填写名称后自动保存`,
  `skuTakenMsg`'s sentences whole, `A SKU is required · 需要填写货号`, `This
  catalog is managed by the upstream system · 该商品目录由上游系统管理`.

The phone's own live pairs: `Price · 价格`, `Cost · 成本`, `Products · 产品`,
`Saving… · 保存中…`, `All changes saved · 已自动保存`, `Save failed: · 保存失败:`,
`Undo · 撤销`, `Version history · 历史版本`, `Enter a price — a number, 0 or
more. · 请输入价格 — 0 或以上的数字。`, `That did not save. Nothing has changed —
try again. · 没有保存成功。数据没有变化 — 请重试。`, `Could not load this. ·
无法加载。`, `Loading… · 加载中…`.

**Composed by Claude, 2026-10-01:**

| shipped | built from |
|---|---|
| `This cost is not complete · 成本不完整` | The desktop's checkbox label is English only (`This cost is not complete`). The Chinese is the phrase the desktop already uses for this tag in its live margin note, `已标记“成本不完整”` (09-products.js). |

**Live candidates rejected:** `显示成本不完整` (from the recipe-unit warning; it
says "the displayed cost is incomplete", a reading, not the operator's
statement).
