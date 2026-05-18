# Roots Mini App

Native WeChat mini program for the Roots B2C storefront. Built against the Roots v2 backend at `rootskitchenchina.com`. Reads layouts from the CMS at `/cms`, products from the main admin's Products page, and copy from `/retail-admin → Copy`.

## Project layout

```
miniapp/
├── app.js                  Boot: fonts, auth, config, language
├── app.json                Pages list, tab bar, theme
├── app.wxss                Design tokens, brand-font chains, utilities
├── project.config.json     Dev-tools config — set your AppID here
├── sitemap.json            WeChat search rules (allow all)
├── pages/
│   ├── home/               Tab 1 — renders home.layout via <block-renderer>
│   ├── shop/               Tab 2 — flat product browser with category chips
│   ├── cart/               Tab 3 — local cart + free-shipping bar
│   ├── me/                 Tab 4 — customer profile + language switch
│   └── onboarding/         First-launch welcome (not in tab bar)
├── components/
│   └── block-renderer/     One component switches on block.type for all 8 types
├── utils/
│   ├── api.js              wx.request wrapper with Bearer token auth
│   ├── config.js           Caches /api/retail/config (60s TTL)
│   ├── lang.js             EN/中 detection, picker, mixed-string splitter
│   ├── fonts.js            wx.loadFontFace for the 5 brand typefaces
│   └── cart.js             Local cart state + tab badge updater
└── assets/
    ├── fonts/              (empty — fonts load from the server, not bundled)
    └── icons/              (TODO — tab-bar PNGs needed before upload)
```

## First-time setup

1. **Install WeChat Developer Tools** (微信开发者工具): https://developers.weixin.qq.com/miniprogram/dev/devtools/
2. **Register a new mini program AppID** at https://mp.weixin.qq.com under the same company (different email — the existing AppID `wxba58433954562887` belongs to the legacy third-party app).
3. **Paste the new AppID into `project.config.json`** (replace `wx0000000000000000`).
4. **Whitelist the API domain** in the mp console:
   - Settings → Development settings → Server domains
   - Add `https://rootskitchenchina.com` under both **request legal domain** and **downloadFile legal domain** (the latter is for the brand fonts at `/assets/fonts/`).
5. **Add the 4 tab-bar icons** to `assets/icons/` as 81×81 PNGs:
   - `home.png` + `home-active.png`
   - `shop.png` + `shop-active.png`
   - `cart.png` + `cart-active.png`
   - `me.png` + `me-active.png`
6. **Open the `miniapp/` folder in WeChat Developer Tools** → Project → Import. The preview window should boot to the Home tab.

## What works now

- Loads `home.layout` from the CMS and renders it via `<block-renderer>`. All 8 block types supported (announcement_bar, hero_banner, category_tabs, featured_item, product_grid, spacer, sticker_collage, progress_dots).
- Brand fonts (Bear Serif / Toni Grotesk / League Gothic / Aleo / DF Yuan W5/W7/W9) load at startup from `/assets/fonts/`.
- Bilingual rendering — customer sees one language at a time. WeChat system language → default; user can override on the Me tab.
- Language switcher persists in storage.
- Cart tab reads local storage and shows free-shipping progress.
- Shop tab renders the product grid from `/api/retail/products` with category filter chips.
- Me tab shows customer profile if authed.
- Silent `wx.login → /api/retail/auth` on launch.

## What's stubbed / TODO (Phase B)

- Product detail page (tap a product → currently shows toast).
- Checkout flow (tap CHECK OUT → toast).
- Order tracking page.
- WeChat Pay JSAPI integration.
- Alipay QR fallback.
- Full membership tier card on Me tab.
- Search tab.
- Animation polish on tab transitions.

## Local dev tips

- The dev tools have a "Disable domain check" toggle if you want to skip the mp-console whitelist while iterating. Re-enable before uploading to test.
- Brand fonts only resolve once `wx.loadFontFace` finishes — first paint after a cold start may show fallback fonts briefly. This is `font-display: swap` behaviour.
- The CMS at `/cms` is the source of truth for what each page renders. Edit there, click Publish, then pull-to-refresh the Home tab in the mini app to see it.

## Backend integration

Reads:
- `GET /api/retail/config` — theme, fees, copy, all page layouts
- `GET /api/retail/products` — published products, filtered by category
- `GET /api/retail/categories` — product category list
- `GET /api/retail/customer` — authed customer profile (requires Bearer token)

Writes:
- `POST /api/retail/auth` — wx.login code → Bearer token
- `POST /api/retail/orders` — checkout (Phase B)

The backend is on the same host (rootskitchenchina.com → HK Aliyun), running the Node + SQLite stack in `/Users/ash/roots-v2/`.
