HEADLINE: SIZES ON THE PHONE — TWO STRINGS COMPOSED BY CLAUDE, TWO LIFTED AS HALVES OF A DESKTOP PAIR, THE REST COPIED WHOLE.

## A product's sizes, edited on the phone (§NEW)

Operator register only (Rule 1). These strings appear on the Variants card of
the phone's product Details screen (`public/m.html`).

**Copied whole from the desktop's Variants table**
(`public/retail-admin/09-products.js`):

- **The card:**
  - `Variants · 规格`
  - `Single option · tap to add · 单一规格 · 点击添加`
  - `+ Add variant · + 新增规格`
  - `Show · 上架`
  - `Show this variant in the shop · 在店面显示此规格`
  - `Edit this variant · 编辑此规格`
  - `Delete this variant · 删除此规格`
- **The label boxes:**
  - `English · e.g. Big 200g · 英文 · 如 Big 200g`
  - `中文 · 如 大 200克`
- **The picker word:**
  - `English · e.g. size, color, flavor · 英文 · 如 size, color`
  - `中文 · 如 规格、颜色、口味 · 中文 · 如 颜色`
  - `Picker heading — blank = “size / 规格”. · 选择器标题 — 留空为「size / 规格」。`
- **The photo:**
  - the three photo names: `Shared from another variant — click to give this one its own photo`, `Change this variant’s photo`, `Add a photo for this variant`, with their pairs
  - `Variant photo updated · 规格图片已更新`
  - `Photo update failed: · 图片更新失败:`
- **Deleting:**
  - `Delete the variant “…”? · 删除规格“…”?`
  - `This removes that product for good. · 将永久删除该产品。`
  - `Size deleted · 规格已删除`
  - `Delete failed: · 删除失败:`
- **Adding:** `Could not add variant: · 无法添加规格:`
- **A taken SKU:** the size clause ` (size “…”) · (规格“…”)` from `skuTakenMsg`

**Phone live pairs reused:** `Hidden · 已隐藏`, `Stock · 库存`, `SKU · 货号`,
`Size / weight · 规格`, `Price · 价格`, `Was price · 划线价`, `Uploading… ·
上传中…`, `Adding… · 添加中…`, `Saving… · 保存中…`, `Move up · 上移`, `Move down ·
下移`, `Load failed · 加载失败`, `Try again · 重试`, and `Enter a price — a number,
0 or more. · 请输入价格 — 0 或以上的数字。`.

**Lifted, 2026-10-01, by Claude.** On the desktop these are two languages
glued into one string. Each half is used here on its own, in the language it
was written in. No words were changed.

| shipped | lifted from |
|---|---|
| `What are these variants? · 这些规格是什么?` | the desktop's `What are these variants? · 这些规格是什么?` heading |
| `Single option · 单一规格` | `Single option · tap to add · 单一规格 · 点击添加`, without the tap. It is shown only to someone who may not add a size. |

**Composed by Claude, 2026-10-01:**

| shipped | built from |
|---|---|
| `Variant added · 已添加规格` | the first clause of the desktop's `Variant added — set its name, SKU, price & stock, then Save. · 已添加规格 — 设置名称、货号、价格、库存后保存。` |
| `Deleting… · 删除中…` | `Delete · 删除` + `中…`, the shape of the live `保存中…` / `添加中…` |

**Live candidates rejected:**

- The desktop's whole `Variant added — … then Save.` sentence. The phone has
  no Save, and the size is already written. The phone opens the new size's
  sheet instead.
- `Saving… · 保存中…` under a delete. It names the wrong action.
