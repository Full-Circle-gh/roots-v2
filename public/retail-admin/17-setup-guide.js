/* eslint-disable no-undef, no-func-assign, no-self-assign */
/* retail-admin app JS — part 17/17.
   New-tenant "Open your store" setup guide. Shares the ONE global scope (cuT,
   api, toast, goTab, salesGo live in earlier parts / the HTML). LOAD ORDER
   MATTERS — this loads last so every tab-open helper it routes into exists.

   The guide is a ROUTER, not a form: each step opens the real page/wizard that
   already exists (Products, the Delivery wizard, the payment config, …). The
   server reports which steps are already satisfied from real data, so steps
   tick themselves off — the operator never checks a box. Surfaces:
     • first login → land on the guide (welcome overlay, then the checklist)
     • a pinned sidebar entry with a live % badge (gone at 100%)
     • a "continue setup" card on top of the dashboard (gone at 100%)
   Nothing is hidden or locked; the rest of the backend stays exactly as it is. */

// Live status, cached between paints. null until the first fetch resolves.
let SETUP = null;

// ── Step catalogue ─────────────────────────────────────────────────────────
// One entry per required step (order = shopkeeper order). `go` routes into the
// real surface. `time` is an honest rough estimate. Copy is plain + concrete,
// one idea per line, bilingual via cuT (never glued into one label).
function suSteps() {
  return [
    { key: 'store', time: '2 min',
      en: 'Tell us about your store', cn: '填写店铺信息',
      subEn: 'Address, phone, opening hours', subCn: '地址、电话、营业时间',
      go: suGoStore },
    { key: 'products', time: '5 min',
      en: 'Add your products', cn: '上架商品',
      subEn: 'A name, a price and a photo is enough to start', subCn: '名称、价格和一张照片就够了',
      go: suGoProducts },
    { key: 'payment', time: '3 min',
      en: 'Choose how customers pay', cn: '选择收款方式',
      subEn: 'Alipay QR works today — WeChat Pay can come later', subCn: '支付宝收款码今天就能用，微信支付可以以后再加',
      go: suGoPayment },
    { key: 'fulfillment', time: '2 min',
      en: 'How customers get their order', cn: '顾客如何拿到货',
      subEn: 'Pickup is already on — turn on delivery too?', subCn: '到店自取已开启，也开通配送？',
      go: suGoFulfillment },
    { key: 'open', time: '1 min',
      en: 'Open the doors', cn: '正式开店',
      subEn: 'Your web store goes live — share the link anywhere', subCn: '网页商店上线，链接随处可分享',
      go: suGoOpen },
  ];
}
// Optional "nice to have" items — never block opening.
function suOptional() {
  return [
    { key: 'wechat', time: 'days',
      en: 'Sell inside WeChat', cn: '入驻微信小程序',
      subEn: 'Needs WeChat accounts and approval — set up when you’re ready', subCn: '需要微信账号和审核，准备好再设置',
      go: suGoWechat },
    { key: 'brand', time: '10 min',
      en: 'Make it look like you', cn: '换上你的品牌形象',
      subEn: 'Logo, brand colour, home page — a neutral look is already in place', subCn: 'Logo、品牌色、首页，默认已有一套中性外观',
      go: suGoBrand },
  ];
}

// ── Data ────────────────────────────────────────────────────────────────────
async function suLoad() {
  try { const j = await api('/api/retail-admin/setup'); SETUP = j.data; return SETUP; }
  catch (e) { return null; }
}
function suStepDone(key) {
  const all = [ ...(SETUP?.steps || []), ...(SETUP?.optional || []) ];
  return !!(all.find(s => s.key === key) || {}).done;
}
async function suSetFlag(patch) {
  try { const j = await api('/api/retail-admin/setup', { method: 'POST', body: patch }); SETUP = j.data; }
  catch (e) { /* leave last-known status on error */ }
  suRefreshChrome();
  return SETUP;
}

// ── Icons (monochrome line SVG, inherit currentColor) ────────────────────────
const SU_ICON = {
  store:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l1-5h16l1 5"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/></svg>',
  products:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7l-8-4-8 4v10l8 4 8-4z"/><path d="M4 7l8 4 8-4M12 11v10"/></svg>',
  payment:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
  fulfillment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8h11v9H5z"/><path d="M16 11h3l2 3v3h-5"/><circle cx="8" cy="19" r="1.6"/><circle cx="18" cy="19" r="1.6"/></svg>',
  open:        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3.5 9h17M3.5 15h17M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>',
  wechat:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
  brand:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 9 9c0-1.1-.9-2-2-2h-2a2 2 0 0 1-2-2V6a2 2 0 0 0-2-2z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7.5" r="1"/><circle cx="14.5" cy="7.5" r="1"/></svg>',
  check:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  arrow:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};

// Progress ring as inline SVG. r=27, circumference≈169.6.
function suRing(percent, size) {
  const p = Math.max(0, Math.min(100, percent || 0));
  const C = 169.6, off = C * (1 - p / 100);
  const s = size || 64;
  return `<div class="su-ring" style="width:${s}px;height:${s}px">
    <svg viewBox="0 0 64 64" style="width:${s}px;height:${s}px">
      <circle cx="32" cy="32" r="27" fill="none" stroke="var(--line,#e8e4da)" stroke-width="6"/>
      <circle cx="32" cy="32" r="27" fill="none" stroke="var(--brass,#a8853b)" stroke-width="6"
              stroke-dasharray="${C}" stroke-dashoffset="${off}" stroke-linecap="round"
              transform="rotate(-90 32 32)"/>
    </svg>
    <div class="su-ring-lbl" style="font-size:${Math.round(s*0.2)}px">${p}%</div>
  </div>`;
}

// ── The guide page (#tab-setup) ──────────────────────────────────────────────
function suRenderGuide() {
  const host = document.getElementById('setup-guide');
  if (!host) return;
  if (!SETUP) { host.innerHTML = `<div class="su-loading">${cuT('Loading…', '加载中…')}</div>`; return; }

  const done = SETUP.requiredDone, total = SETUP.requiredTotal;
  const next = suSteps().find(s => !suStepDone(s.key));
  const nextLine = SETUP.allDone
    ? cuT('Everything’s done — your store is open.', '全部完成 — 你的店已经开张。')
    : cuT('Next: ', '下一步：') + (next ? cuT(next.en, next.cn) : '');

  const rowHtml = (s, isOpt) => {
    const isDone = suStepDone(s.key);
    const isNext = !isOpt && !isDone && next && s.key === next.key;
    const cls = isDone ? 'done' : isNext ? 'now' : (isOpt ? 'opt' : '');
    const st = isDone
      ? `<div class="su-st">${SU_ICON.check}</div>`
      : `<div class="su-st">${SU_ICON[s.key] || ''}</div>`;
    const right = isDone
      ? `<span class="su-donechip">${SU_ICON.check}${cuT('Done', '已完成')}</span>`
      : `<span class="su-time">${s.time}</span>
         <button class="btn btn-sm${isNext ? ' btn-primary' : ''}" type="button" onclick="suRun('${s.key}')">${isNext ? cuT('Set up', '去设置') : cuT('Open', '打开')}</button>`;
    return `<div class="su-task ${cls}">
      ${st}
      <div class="su-tx"><b>${cuT(s.en, s.cn)}</b><span>${cuT(s.subEn, s.subCn)}</span></div>
      ${right}
    </div>`;
  };

  host.innerHTML = `
    <div class="su-card">
      <div class="su-ghead">
        <div>
          <h2 style="margin:0">${cuT('Open your store', '把店开起来')}</h2>
          <p class="su-sub">${done} ${cuT('of', '/')} ${total} ${cuT('done', '完成')}. ${escapeHtml(nextLine)}</p>
        </div>
        ${suRing(SETUP.percent, 64)}
      </div>
      <div class="su-tasks">
        ${suSteps().map(s => rowHtml(s, false)).join('')}
        <div class="su-divider">${cuT('Nice to have — do these anytime', '锦上添花 — 随时可做')}</div>
        ${suOptional().map(s => rowHtml(s, true)).join('')}
      </div>
    </div>`;
}

// Run a step: mark intent, route into the real surface. `open` and `fulfillment`
// have their own confirm-flows; the rest just navigate.
function suRun(key) {
  const step = [...suSteps(), ...suOptional()].find(s => s.key === key);
  if (step && typeof step.go === 'function') step.go();
}

// ── Routes into real surfaces ────────────────────────────────────────────────
// Each opens the page/wizard that already exists. Where a "back to guide" strip
// helps, we drop a one-shot hint the target page can show (suReturnHint).
function suReturnHint(msgEn, msgCn) {
  try { sessionStorage.setItem('su_return', JSON.stringify({ en: msgEn, cn: msgCn })); } catch (_) {}
}
function suGoStore() {
  // Store address lives in Settings → Operations → Stores.
  suReturnHint('Add your store address, then this step ticks itself off.', '填写门店地址后，此步骤会自动完成。');
  goTab('config');
  // Open the Operations sub-panel where Stores lives.
  const opsBtn = document.querySelector('#settings-nav button[data-sub="ops"]');
  if (opsBtn) opsBtn.click();
  suScrollTo('#qs-stores, [data-store-list], #ops-stores');
}
function suGoProducts() {
  suReturnHint('Add at least one product, then this step ticks itself off.', '上架至少一个商品，此步骤会自动完成。');
  goTab('products');
}
function suGoPayment() {
  // Payment methods live on the Mini App / Web config; the quickest live path is
  // the manual-Alipay card in Settings → Operations.
  suReturnHint('Turn on a payment method, then this step ticks itself off.', '开启一种收款方式后，此步骤会自动完成。');
  goTab('config');
  const opsBtn = document.querySelector('#settings-nav button[data-sub="ops"]');
  if (opsBtn) opsBtn.click();
  suScrollTo('#alipay-manual-enabled, [data-pay-methods]');
}
function suGoFulfillment() {
  // Pickup is on by default; offer delivery (the 3-question wizard) or confirm
  // pickup-only. A tiny chooser keeps the guide honest without a new page.
  suFulfillChooser();
}
function suGoWechat() {
  // The Mini App credentials wizard (part 15).
  if (typeof igLaunchSetup === 'function') { igLaunchSetup('wechat_miniapp'); return; }
  if (typeof igMiniappConfig === 'function') { igMiniappConfig(); return; }
  salesGo('config');
}
function suGoBrand() {
  openMiniAppEditor && openMiniAppEditor();
}
function suGoOpen() { suOpenDoors(); }

function suScrollTo(sel) {
  setTimeout(() => {
    const el = document.querySelector(sel);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 250);
}

// ── Fulfillment chooser ──────────────────────────────────────────────────────
function suFulfillChooser() {
  const ov = suModal(`
    <div class="su-mhead">
      <h3>${cuT('How customers get their order', '顾客如何拿到货')}</h3>
      <button class="su-x" type="button" onclick="suCloseModal()">✕</button>
    </div>
    <p class="su-mnote">${cuT('Pickup at your store is already on. You can add delivery now, or keep pickup only for now.', '到店自取已开启。你可以现在开通配送，或暂时只做自取。')}</p>
    <div class="su-choose">
      <button class="su-choice" type="button" onclick="suCloseModal(); suStartDelivery()">
        <span class="su-choice-ic">${SU_ICON.fulfillment || SU_ICON.store}</span>
        <b>${cuT('Set up delivery', '开通配送')}</b>
        <span>${cuT('Three quick questions', '三个小问题')}</span>
      </button>
      <button class="su-choice" type="button" onclick="suConfirmPickup()">
        <span class="su-choice-ic">${SU_ICON.store}</span>
        <b>${cuT('Pickup only for now', '暂时只做自取')}</b>
        <span>${cuT('Customers collect at your store', '顾客到店自取')}</span>
      </button>
    </div>`);
  return ov;
}
function suStartDelivery() {
  suReturnHint('Finish the delivery questions, then this step ticks itself off.', '完成配送设置后，此步骤会自动完成。');
  goTab('delivery');
  // The Delivery tab shows its own new-user wizard when unconfigured (part 06).
  setTimeout(() => { if (typeof dlvWizOpen === 'function') try { dlvWizOpen(1); } catch (_) {} }, 300);
}
async function suConfirmPickup() {
  await suSetFlag({ pickupConfirmed: true });
  suCloseModal();
  toast(cuT('Pickup confirmed', '已确认自取'), 'ok');
  suRenderGuide();
}

// ── Open the doors ───────────────────────────────────────────────────────────
function suOpenDoors() {
  // Guard: opening before the essentials are done would put a broken store live.
  const blockers = suSteps().filter(s => s.key !== 'open' && !suStepDone(s.key));
  if (blockers.length) {
    const names = blockers.map(s => cuT(s.en, s.cn)).join(cuT(', ', '、'));
    suModal(`
      <div class="su-mhead"><h3>${cuT('Almost there', '就差一点')}</h3>
        <button class="su-x" type="button" onclick="suCloseModal()">✕</button></div>
      <p class="su-mnote">${cuT('Finish these first so customers get a working store:', '先完成这些，顾客才能看到一个可用的店：')}<br><b>${escapeHtml(names)}</b></p>
      <div class="su-mfoot"><button class="btn btn-primary" type="button" onclick="suCloseModal()">${cuT('OK', '好的')}</button></div>`);
    return;
  }
  suModal(`
    <div class="su-mhead"><h3>${cuT('Open your store now?', '现在开店？')}</h3>
      <button class="su-x" type="button" onclick="suCloseModal()">✕</button></div>
    <p class="su-mnote">${cuT('Your web store goes live and can take orders. You can keep editing anything afterwards.', '你的网页商店将上线并可接单。之后仍可继续编辑任何内容。')}</p>
    <div class="su-mfoot">
      <button class="btn" type="button" onclick="suCloseModal()">${cuT('Not yet', '还没')}</button>
      <button class="btn btn-primary" type="button" onclick="suDoOpen()">${cuT('Open the doors', '正式开店')}</button>
    </div>`);
}
async function suDoOpen() {
  await suSetFlag({ storeOpened: true });
  suCloseModal();
  suDoneScreen();
}

// ── Done screen ──────────────────────────────────────────────────────────────
function suDoneScreen() {
  const pending = suOptional().filter(s => !suStepDone(s.key));
  const pendHtml = pending.length ? `
    <div class="su-pend">
      <b>${cuT('Still waiting for you — whenever you’re ready', '还差这些 — 你随时可以补上')}</b>
      ${pending.map(s => `<div class="su-pend-row">
        ${SU_ICON.wechat}
        <span>${cuT(s.en, s.cn)}</span>
        <button class="btn btn-sm" type="button" onclick="suCloseModal(); suRun('${s.key}')">${cuT('Finish now', '现在完成')}</button>
      </div>`).join('')}
    </div>` : '';
  suModal(`
    <div class="su-done-hero">
      <div class="su-done-big">${SU_ICON.check}</div>
      <h3>${cuT('Your store is open', '你的店开张了')}</h3>
      <p>${cuT('Customers can browse, order and pay right now.', '顾客现在就能浏览、下单、付款。')}</p>
    </div>
    ${pendHtml}
    <div class="su-mfoot">
      <button class="btn" type="button" onclick="suCloseModal(); goTab('dashboard')">${cuT('Go to dashboard', '前往仪表板')}</button>
      <button class="btn btn-primary" type="button" onclick="suCloseModal(); goTab('setup')">${cuT('Back to guide', '返回引导')}</button>
    </div>`, { wide: false });
  suRefreshChrome();
}

// ── Welcome overlay (first login only) ───────────────────────────────────────
function suWelcome() {
  const steps = suSteps();
  suModal(`
    <div class="su-mhead">
      <h3>${cuT('Welcome — let’s open your store', '欢迎 — 一起把店开起来')}</h3>
      <button class="su-x" type="button" onclick="suDismissWelcome()">✕</button>
    </div>
    <p class="su-mnote">${cuT('Five short steps. Stop anytime and pick up where you left off.', '五个小步骤。随时可以暂停，下次接着做。')}</p>
    <div class="su-wsteps">
      ${steps.map(s => `<div class="su-wstep">
        <span class="su-wico">${SU_ICON[s.key] || ''}</span>
        <b>${cuT(s.en, s.cn)}</b><span class="su-wt">${s.time}</span>
      </div>`).join('')}
    </div>
    <div class="su-promise">${SU_ICON.check}
      <p>${cuT('Your web store can take its first order today — no approvals needed. Selling inside WeChat takes longer and can be set up later.', '网页商店今天就能接第一单，无需任何审批。微信小程序需要更长时间，可以以后再设置。')}</p>
    </div>
    <div class="su-mfoot">
      <button class="btn" type="button" onclick="suDismissWelcome()">${cuT('I’ll look around first', '我先随便看看')}</button>
      <button class="btn btn-primary" type="button" onclick="suStartFromWelcome()">${cuT('Start — step 1', '开始 — 第 1 步')} ${SU_ICON.arrow}</button>
    </div>`, { wide: true });
}
async function suDismissWelcome() {
  suCloseModal();
  await suSetFlag({ welcomeSeen: true });
}
async function suStartFromWelcome() {
  suCloseModal();
  await suSetFlag({ welcomeSeen: true });
  goTab('setup');
}

// ── Shared modal ─────────────────────────────────────────────────────────────
function suModal(innerHtml, opts) {
  suCloseModal();
  const ov = document.createElement('div');
  ov.id = 'su-modal';
  ov.className = 'su-modal-ov';
  ov.onclick = (e) => { if (e.target === ov) suCloseModal(); };
  ov.innerHTML = `<div class="su-modal${opts && opts.wide ? ' wide' : ''}" role="dialog" aria-modal="true">${innerHtml}</div>`;
  document.body.appendChild(ov);
  requestAnimationFrame(() => ov.classList.add('open'));
  return ov;
}
function suCloseModal() { const ov = document.getElementById('su-modal'); if (ov) ov.remove(); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') suCloseModal(); });

// ── Chrome: sidebar badge + dashboard card ───────────────────────────────────
// Both appear only while setup is unfinished, and vanish for good at 100%.
function suRefreshChrome() {
  const hide = !SETUP || SETUP.allDone;
  // Sidebar pinned entry.
  const nav = document.getElementById('setup-nav');
  if (nav) {
    nav.style.display = hide ? 'none' : '';
    const badge = document.getElementById('setup-nav-badge');
    if (badge && SETUP) badge.textContent = SETUP.percent + '%';
  }
  // Dashboard card.
  suRenderDashCard();
}
function suRenderDashCard() {
  const host = document.getElementById('setup-dash-card');
  if (!host) return;
  if (!SETUP || SETUP.allDone) { host.innerHTML = ''; host.style.display = 'none'; return; }
  const next = suSteps().find(s => !suStepDone(s.key));
  host.style.display = '';
  host.innerHTML = `
    <div class="su-dashcard">
      ${suRing(SETUP.percent, 52)}
      <div class="su-dashcard-tx">
        <b>${cuT('Your store isn’t open yet', '你的店还没开张')}</b>
        <span>${cuT('Next: ', '下一步：')}${next ? cuT(next.en, next.cn) : ''}${next ? ' · ' + next.time : ''}</span>
      </div>
      <button class="btn btn-primary" type="button" onclick="goTab('setup')">${cuT('Continue setup', '继续设置')} ${SU_ICON.arrow}</button>
    </div>`;
}

// ── Boot ─────────────────────────────────────────────────────────────────────
// Called from the bootstrap (part 02). Loads status, wires the guide tab's
// lazy render, paints chrome, and — on genuine first login — lands the operator
// on the guide (with the welcome overlay). Re-render the guide whenever its tab
// is opened so it reflects freshly-completed steps.
let _suBooted = false;
async function suInit() {
  if (_suBooted) return; _suBooted = true;
  const nav = document.querySelector('.tabs [data-tab="setup"]');
  if (nav) nav.addEventListener('click', () => { suLoad().then(() => { suRenderGuide(); suRefreshChrome(); }); });
  await suLoad();
  if (!SETUP) return;
  suRefreshChrome();
  suRenderGuide();
  if (SETUP.firstLogin && !SETUP.allDone) {
    goTab('setup');
    suWelcome();
  }
  // Keep chrome honest after the operator finishes a step elsewhere and comes
  // back to the dashboard: cheap re-fetch when the dashboard tab is shown.
  const dashBtn = document.querySelector('.tabs [data-tab="dashboard"]');
  if (dashBtn) dashBtn.addEventListener('click', () => { suLoad().then(suRefreshChrome); });
}
window.suInit = suInit;
