# Admin Console — Information Architecture Blueprint

> Companion to `ADMIN-FEATURE-INVENTORY.md` (which lists *what exists*).
> This document defines *how it's organized* in the redesign: the navigation model,
> every screen sorted into a group, the new features we're adding, and what each role sees.
> Built for a **platform sold to businesses of any size** — so the navigation **adapts** to the team.

---

## 1. The navigation model — one adaptive grouped sidebar

- The whole admin is **one left sidebar**, not a row of zone tabs you switch between.
- Sections are organized into **3 groups by how often / who uses them**: **RUN · SELL · SET UP**.
- **Role + plan decide what shows:**
  - A **solo boss** sees all three groups in one nav — nothing hidden, no switching. Feels flat and simple.
  - **Staff** see only their group(s). Feels focused.
  - **Plan/entitlement** hides any section a business didn't buy (reuses existing `ent-`/`feat-` gating).
- **Escape hatches** so a multi-hat owner is never slowed down:
  - **Pinned bar** — each person pins the 5–6 sections they touch daily (across any group) into one row.
  - **Ctrl + K** — jump to any screen by name, group-agnostic (already exists).
  - **Opens on last-used section.**

**Governing principle:** pull the *action / toggle* into **RUN**; leave the *builder / config* in **SELL / SET UP**. Same object, two depths.

---

## 2. The three groups (full contents)

### RUN · Daily operations  *(reactive, used constantly — Staff-accessible)*

| Section | What's in it |
|---|---|
| **Dashboard** | Live pulse, today's KPIs, activity feed, deep-dive reports. Low-stock / out-of-stock / refund signals **link into Inventory & Orders (not the builder)**. |
| **Orders** | Order list + detail; fulfillment (prepare → dispatch → deliver); refunds & refund queue; invoices (发票); printing (receipt, box label). **+ Create order** (new), **+ Reschedule delivery** (new), **+ Returns to stock** (new). |
| **Inventory** *(new surface)* | Stock counts per store (inline edit); mark sold-out / restock toggle; **Receive incoming stock** (new, with movement log); low / out lists; search. **No price, names, photos, or delete.** |
| **Store status** *(new surface)* | Quick daily switches: Open / Closed today · Holiday mode · Pause same-day delivery · stop a live flash deal · **Send a quick notice** (new). *Building these still lives in SET UP / SELL.* |
| **Inbox** | Reviews · Feedback (respond, mark seen). |
| **Customers** | Lookup; profile; adjust points / wallet; addresses; block / unblock; diagnostics. **+ Give coupon** (new — service recovery). |

### SELL · Build & grow  *(proactive, weekly-ish — Admin)*

| Section | What's in it |
|---|---|
| **Catalog** | Products (full editor: names, pricing, photos, description), variants, bundles, options, categories, the PDP design-block editor, full stock editor. **+ Cost price & profit** (new). |
| **Marketing** | Coupons · Flash sales · Pop-ups · Affiliate · Share cards · Broadcasts · Social proof. |
| **Loyalty** | Membership & tiers · Top-up packages · Leaderboard · Voting. |
| **Storefront** | Home / CMS editor · Copy · About page · Media library · Legal pages · FAQ. |

### SET UP · Configure  *(rare, one-time — Admin / Owner)*

| Section | What's in it |
|---|---|
| **Stores & operations** | Stores, logistics integrations (Kuaidi100 / JD), printers, maps/geocoding. |
| **Delivery** | Zones, fees, time slots, holiday *message & rules*, fresh-batch schedule, reschedule cutoff. |
| **Payments** | Alipay (manual QR + OCR), WeChat, manual payment methods. |
| **Notifications & messaging** | Push template, SMS (Aliyun), WeCom new-order alerts, customer-service chat bubble, auto-notification categories. |
| **Team & roles** | Team members · **Custom roles** (new) · **Staff activity log** (new). |
| **Billing & plan** | Subscription / plan (platform-level). |

---

## 3. New features being added (not in the system today)

| Feature | Lives in | Who | One-liner |
|---|---|---|---|
| **Create order for a customer** | RUN → Orders | Staff+ | Make an order on a customer's behalf (phone-in / counter / POS-style). |
| **Reschedule a delivery** | RUN → Orders | Staff+ | Move a customer's delivery / pickup time from the admin. |
| **Returns to stock / exchanges** | RUN → Orders + Inventory | Staff+ | On refund, optionally put items back into inventory; handle exchanges, not just money-back. |
| **Inventory surface** | RUN → Inventory | Staff+ | Thin stock-only screen (counts, sold-out, receive). |
| **Receive incoming stock** | RUN → Inventory | Staff+ | Log arriving stock (+N, note) → creates a stock-movement audit trail. |
| **Store status panel** | RUN → Store status | Staff+ | One place for daily open/close & deal switches. |
| **Quick notice** | RUN → Store status | Staff+ | Fast operational announcement (delay / closure), separate from marketing. |
| **Give coupon** | RUN → Customers | Staff+ | One-tap coupon to a single customer for service recovery. |
| **Cost price & profit** | SELL → Catalog | Admin+ | Track product cost → show profit / margin, not just revenue. |
| **Custom staff roles** | SET UP → Team & roles | Owner | Define roles beyond Owner/Admin/Staff (e.g. a "packer" who sees only Orders + Inventory). |
| **Staff activity log** | SET UP → Team & roles | Owner / Admin | Record of who changed stock / refunded / cancelled — for handovers & accountability. |

---

## 4. Role × visibility (defaults)

Roles are **starting defaults** — Custom roles can mix and match any sections.

| Group / Section | Owner | Admin | Staff (default) |
|---|:--:|:--:|:--:|
| **RUN** — Dashboard | ✓ | ✓ | ✓ |
| RUN — Orders | ✓ | ✓ | ✓ |
| RUN — Inventory | ✓ | ✓ | ✓ |
| RUN — Store status | ✓ | ✓ | ✓ |
| RUN — Inbox | ✓ | ✓ | ✓ |
| RUN — Customers | ✓ | ✓ | ✓ |
| **SELL** — Catalog | ✓ | ✓ | ✗ |
| SELL — Marketing | ✓ | ✓ | ✗ |
| SELL — Loyalty | ✓ | ✓ | ✗ |
| SELL — Storefront | ✓ | ✓ | ✗ |
| **SET UP** — Stores & operations | ✓ | ✓ | ✗ |
| SET UP — Delivery | ✓ | ✓ | ✗ |
| SET UP — Payments | ✓ | ✓ | ✗ |
| SET UP — Notifications & messaging | ✓ | ✓ | ✗ |
| SET UP — Team & roles | ✓ | ✗ | ✗ |
| SET UP — Billing & plan | ✓ | ✗ | ✗ |

- **Owner** = everything. **Admin** = RUN + SELL + most SET UP (not Team/roles or Billing). **Staff** = RUN only.
- **Custom role example "Packer":** RUN → Orders + Inventory only.
- **Plan gating** is layered on top: even if a role *could* see a section, it's hidden if the business's plan doesn't include it.

---

## 5. Deep-link re-targets (make the split real)

These daily signals must point at the **RUN** operational screen, not the SELL builder:

- Dashboard **Low-stock tile** → RUN Inventory
- Dashboard **Out-of-stock tile** → RUN Inventory
- Orders row **`⚠ needs restock` badge** → RUN Inventory (filtered to that product)

---

## 6. Open polish items (later)

- **Naming:** "RUN / SELL / SET UP" are placeholders — need final names + bilingual EN / 中文 labels.
- **Mobile:** the same grouped sidebar collapses into the existing bottom-nav + "More" sheet, filtered by role.
- **Deprioritized for now** (not dropped): export reports (CSV/Excel), bulk product import.
