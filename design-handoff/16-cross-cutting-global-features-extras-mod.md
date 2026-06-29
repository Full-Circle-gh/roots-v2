> Design hand-off — paste this when designing **15. Cross-cutting / global features (Extras module)**.
> Structure only (every field/button/status). Pair with `ADMIN-IA-BLUEPRINT.md` for where it sits in the nav.

## 15. Cross-cutting / global features (Extras module)

- **Bilingual auto-translate engine** — splits `EN · CN` text, translates `data-tip` tooltips / titles / opt-in placeholders / prose block-pairs; opt-out via `data-no-i18n`; MutationObserver covers JS-injected content. Globals `cuToggleLang / cuT / cuLang / onLangChange`.
- **Help tooltip** — single floating popup for any `.help-i[data-tip]`.
- **Topbar controls** — Text size (100/110/125%), Theme (light/dark), EN/中文.
- **Live Preview drawer** — phone-shaped iframe of the storefront (`/storefront?preview=1`); Refresh / Open in new tab.
- **`?tab=` deep-link boot** — `/retail-admin?tab=orders` auto-opens that tab (used by push notifications).
- **"A new version is available · 有新版本可用" banner** — polls `/api/version`; Reload / dismiss.

---
