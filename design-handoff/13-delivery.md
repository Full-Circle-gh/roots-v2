> Design hand-off — paste this when designing **12. Delivery · 配送**.
> Structure only (every field/button/status). Pair with `ADMIN-IA-BLUEPRINT.md` for where it sits in the nav.

## 12. Delivery · 配送

### Coverage KPI strip
- `Active zones · 启用配送区` / `Provinces · 覆盖省份` / `Same-day · 同日达` / `Disabled · 已停用`.

### Cards
- **Global defaults:** kitchen address.
- **Delivery & pickup fees:** Free-shipping threshold · Standard fee · Same-day fee · Pickup packing fee · Pickup hours (open/close) · Minimum order.
- **Holiday mode:** status toggle, message EN/CN.
- **Fresh batch schedule:** status, anchor date, interval days, skip dates, popup copy (eyebrow/title/notice EN/CN).
- **Fresh order reschedule cutoff:** lock-at-hour (evening before).
- **Default delivery — rest of China:** status, flat fee, free-over, packing/item, packing cap, lead time.
- **GZ excluded-districts** chip grid.

### Delivery-zone table
- Sub-tabs: `Pricing · 定价` / `Scheduling · 时间`; search; `Add zone`; **View** popover (row density, badge style).
- Pricing columns: Zone (type chip GZ/City/City-wide/Province) · Base ¥ · Free over ¥ · Extras · On.
- Scheduling columns: Zone · Mode (Day-only / Time-slot) · Lead→Max · Same-day · Hours · Slot.
- Row actions: Duplicate / Delete; row click → drawer.

### Zone add/edit drawer
- Type segment (GZ district / Other city); location picker (district/city chips); display-name overrides.
- Pricing: Base fee · Free over · MAX flat (GZ) · Packing ¥/item (city) · Packing cap (city).
- Scheduling: Earliest lead · Furthest day · Kitchen hours · Slot length · Allow same-day (+SD fee, GZ) · Day-only.
- Active toggle; Delete / `Apply to others` / Save.
- **Apply panel:** which fields (Pricing / Scheduling / Active toggle) → which zones (All GZ / All cities / All / Clear).

### Zone field set
`zone_type, match_district, match_city, name_cn, name_en, base_fee, free_threshold, max_fee, packing_fee_per_item, packing_fee_cap, min_lead_days, max_lead_days, slot_start_hour, slot_end_hour, slot_duration_minutes, same_day_allowed, same_day_surcharge, day_only, is_active`.

> Carriers / shipment modes (air/land/rider/JD) are configured in **Operations** (logistics integration) and set per-order in **Orders**, not here.

---
