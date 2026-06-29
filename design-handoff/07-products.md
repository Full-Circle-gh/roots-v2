> Design hand-off — paste this when designing **6. Products · 产品 (catalog management)**.
> Structure only (every field/button/status). Pair with `ADMIN-IA-BLUEPRINT.md` for where it sits in the nav.

## 6. Products · 产品 (catalog management)

### Product list
- **KPI strip (clickable filters):** `Live` / `Out of stock` / `Low stock` (`≤ N left · 剩余 ≤ N`) / `Drafts`. + low-stock threshold input.
- **Toolbar:** search (name/SKU); Category filter; Subcategory filter; count readout; `Guided add · 向导添加`; `＋ Add manually · 手动新增`; **Layout** segment (Grid/Compact/List); **View** popover (Photo crop square/portrait/full, Status display badge/border/minimal, Empty photo icon/hatched/plain).
- **Multi-store stock switcher** (2+ stores) — `Stock for · 库存门店` All + per-store (editable when single store picked).
- **List columns:** drag grip · select · thumbnail · `Product · 产品` (EN+CN) · `Category · 分类` · `SKU` (or `N sizes · 规格`) · `Stock · 库存` (tinted; editable per store) · `Price · 价格` (or range) · `Shop · 上架` toggle.
- **Status pills:** `Designed` / `Plain` / `Draft` / `Variants` / `Bundle · 套装` / `Out of stock · 缺货`.
- **Bulk action bar:** Shop On/Off · Markets Yes/No · Fresh batch Yes/No · Shipping (Air+Land / Air only / Land only) · Badge (None/Auto/NEW/POP/SALE/HOT) · Delete.
- Drag-to-reorder; pager (50/100/200/All).

### Product editor (commercial form)
- **Main column:**
  - **Photos · 图片** — gallery (drag-reorder, Main · 主图, remove), upload, `🖼️ From library · 从图库选择` (≤8).
  - `Name EN · 名称(英文)` / `Name 中文`.
  - **Variants** (see below) · **Bundle (sold as one) · 套装产品** · **Buy together · 一起买** · **Options (customer chooses) · 选项**.
  - **Product details · 产品详情** (+ `Auto-fill from text · 智能填充`): Origin / Ingredients / Storage / Shelf life / Serving suggestion (each EN/CN).
  - **Description · 描述** — mode bar `Classic · 经典` / `Product editor ↗` / `Design On/Off` (`use_block_design`); stale-rebuild banner; full rich-text toolbar; side-by-side EN / 中文 editors.
- **Sidebar:**
  - `Show in shop · 在店面显示` publish.
  - **Flags · 标记:** `Sold at markets · 市集销售` / `Made fresh in batches · 分批现做` / `Ships directly from supplier · 供应商直发` / `Restock-only, internal · 仅内部补货`; **Out of stock policy** select (`Sold out everywhere · 全国售罄停售` strict / `Pre-order outside Guangzhou · 广州外可预订` backorder_gz).
  - **Pricing · 价格:** `Price ¥` / `Was price · 划线价`.
  - **Stock & status · 库存与状态:** `SKU · 货号`; Status select (`Active · 在售` / `Inactive · 停售` / `Seasonal · 季节性` / `Coming Soon · 即将上架`); per-variant×store stock matrix; `Low-stock alert at · 低库存提醒阈值`.
  - **Organization · 分类:** `Shop section · 商店分区` / `Subcategory · 子分类` / `Badge · 标签` (None/Auto/NEW/POP/SALE/HOT) / `Size · 规格`; `Free of (allergens) · 不含` (Nuts/Soy/Gluten/5 Spice); `Shipping · 配送方式` (Air/Land/Local only, Local exclusive).
  - **Internal notes · 内部备注**.
- **Footer:** Duplicate · 复制 / Delete · 删除 / autosave status / `Version history · 历史版本` (restore). Brand-new product auto-mints `DRAFT-` SKU; no manual save.

**Variants panel:** per-variant photo, Name EN/CN (`variant_label`/`_cn`), SKU, Weight, ¥, Was, Stock (per-store total), Show toggle, delete; `+ Add variant · 新增规格`, drag-reorder.
**Bundle-product panel:** component chips + `×qty`; `+ Add product`.
**Buy-together panel:** Title EN/CN, product chips, bundle price, auto-voucher.
**Options panel:** per option — Question EN/CN, type (`Pick one · 单选` / `Pick any · 多选` / `Type an answer · 填写`), Required; per choice — default, Choice EN/CN, `+¥` delta, stock-product link; `+ Add a pick (free)` / `+ Add paid extras`.

### Standalone Design-Block PDP editor (`/product-editor`)
- Top bar: Back · brand · product switcher · Live/Draft badge · language toggle · save status · `Save · 保存`.
- Left rail: Product list; **Card chrome** (Keywords EN/CN, Tagline EN/CN); **Colophon** (IP character grid of 10 mascots + Auto, Tagline EN/CN); **Sections** list (`+ Add section…`, `Smart paste · 智能粘贴`, draggable blocks).
- Center: phone-canvas preview. Right inspector: Block / Templates.
- **Block types:** `spec_strip · 规格条`, `hero_intro · 开篇引言`, `why · 为什么选它`, `ingredients_chips · 配料·云标签`, `ingredients_line · 配料·编辑式`, `allergen_card · 过敏原卡`, `how_to_use · 用法宫格`, `storage_box · 储存条件`, `notes_callout · 备注说明`, `big_stat · 大数字`, `callout_banner · 醒目横幅`, `pull_quote · 引文`, `image_band · 图片横幅`, `recipe_steps · 做法步骤`, `pairings · 搭配推荐`, `faq · 常见问题`, `nutrition_facts · 营养成分`.
- Smart-paste modal (split EN+CN copy into sections); template chooser.

### Enums
OOS policy `strict / backorder_gz`; Status `Active / Inactive / Seasonal / Coming Soon`; Badge `auto / new / pop / sale / hot`; Ship modes `air / land / local`; Option types `single / multi / text`.

---
