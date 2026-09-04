/* eslint-disable no-undef, no-func-assign, no-self-assign */
/* retail-admin app JS — part 10/10.
   All 10 parts share ONE global scope and are loaded sequentially by
   retail-admin.html — LOAD ORDER MATTERS. Cross-file globals (cuT, cuLang,
   DASH_VIEW, rm* mobile renderers…) live in other parts or in the inline
   script blocks still in the HTML, hence the eslint no-undef opt-out.
   Contents: affiliate tab (afx*), theme + UI scale, i18n engine (cuT/cuToggleLang/onLangChange), help tooltip, leaderboard, polls/voting, About page, live preview drawer, ?tab= deep-link boot */
// ════════════════════════════════════════════════════════════════
// AFFILIATE — built from scratch 2026-08-24 against the Tacet design-system
// specimen "Affiliate — page (A1·A2·A3)". The previous af2-/afc- two-column
// build (right-rail settings, hover-only row actions, no pagination) was
// deleted outright; nothing here descends from it. Only afStatusPill survives,
// and only because the CUSTOMER DRAWER renders it outside this tab.
//
// Shape: program card → stats → one 680px settings column → referral ledger,
// with a pinned save bar that appears when something is edited. Every string
// goes through cuT, so every region is data-no-i18n and re-renders on the
// language switch.
//
// THREE BLOCKS OF THE SPECIMEN ARE DELIBERATELY NOT BUILT, because the product
// has no such thing and a settings control that saves nowhere is a lie
// (§1.17 / the Pop-ups "on-scroll trigger" precedent):
//   · reward TYPES (coupon / percentage off / free item) — affiliate rewards
//     are store credit in ¥, full stop (routes/retail.js affiliateSettings);
//   · MILESTONE BONUSES ("after 3 rewarded referrals → ¥50") — no schema, no
//     payout path, nothing anywhere in the codebase;
//   · PLACEMENT toggles (after checkout / order status page) — the invite has
//     exactly one home, the Refer a friend page; no order surface renders it.
// The sentence-builder, the opt-in confirm, the ledger and the save bar are
// all built as designed. Code prefix + share picture are kept although the
// specimen dropped them: both are real, wired controls with no other home.
// ════════════════════════════════════════════════════════════════

const AFX_PAGE_SIZE = 20;
const AFX_LIFETIME_START_PCT = 5;      // what "keep rewarding repeat orders" starts at
const AFX_SAVE_KEYS  = ['rewardPerOrder', 'rewardReferee', 'lifetimeRatePercent', 'lifetimeMonths', 'lifetimeMode', 'codePrefix', 'shareImage'];
const AFX_MONEY_KEYS = ['rewardPerOrder', 'rewardReferee', 'lifetimeRatePercent', 'lifetimeMonths'];

// Monochrome line icons, never emoji. Sized by the scoped CSS.
const afxSvg = (d, w) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w || 1.75}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const AFX_I = {
  search:  afxSvg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
  refresh: afxSvg('<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>'),
  chevl:   afxSvg('<path d="m15 18-6-6 6-6"/>'),
  chevr:   afxSvg('<path d="m9 18 6-6-6-6"/>'),
  alert:   afxSvg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>'),
  wave:    '<svg class="wave" viewBox="0 0 340 110" fill="none" aria-hidden="true"><path d="M20 55C30 15 40 95 50 55C59 22 68 88 77 55C85 30 93 80 101 55C109 38 117 72 125 55C133 44 141 66 149 55C160 50 171 60 182 55C215 55 260 55 305 55" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>',
};

const AFX = {
  booted: false,
  cfg: null,             // live settings, edited in place
  saved: null,           // last-saved snapshot, for the dirty compare
  progBusy: false,
  lifeArm: false,        // inline confirm while arming the repeat-order share
  eligCount: null,       // how many customers are picked for the ongoing share (null = not read yet)
  eligBusy: false,       // a pick/un-pick write is in flight inside the manage dialog
  rows: [], summary: null, total: 0, page: 1,
  filter: '', query: '',
  ledger: 'loading',     // loading | ok | empty | nomatch | error
  ledgerErr: '',
  rowConfirm: null,      // { id, kind: 'void' | 'restore' }
  rowBusy: false,
  saving: false, saveErr: '', saveSaid: false,
  uploading: false,
  ov: null,              // the overview read: reach, money, placements
  ovErr: '',
  settingsOpen: false,   // the offer card's settings disclosure
  settingsErr: '',       // the settings column could not be LOADED
  progErr: '',           // turning the program on/off failed
  picErr: '',            // the share picture upload failed
};

const afT = (en, cn) => (typeof cuT === 'function' ? cuT(en, cn) : en);
// api() throws with the server's error CODE as the message. A code is not a
// sentence — say what actually went wrong, and only fall back to the raw code
// for things this page didn't anticipate.
function afxWhy(e) {
  const code = (e && (e.code || e.message)) || '';
  const map = {
    bad_reward:          () => afT('A reward has to be between ' + acWrap(0) + ' and ' + acWrap('10,000') + '.', '奖励金额需在 ' + acWrap(0) + ' 到 ' + acWrap('10,000') + ' 之间。'),
    bad_lifetime_rate:   () => afT('The repeat-order share has to be between 0% and 50%.', '复购分成比例需在 0% 到 50% 之间。'),
    bad_lifetime_months: () => afT('The share can last up to 120 months. Use 0 for no end date.', '分成最长 120 个月。设为 0 表示不设期限。'),
    bad_lifetime_mode:   () => afT('Who earns the repeat-order share could not be saved. Reload the page and set it again.', '复购分成的可获得范围保存失败。请刷新页面后重新设置。'),
    bad_prefix:          () => afT('A code prefix can only use letters, numbers and dashes.', '邀请码前缀只能使用字母、数字和短横线。'),
    bad_share_image:     () => afT('That picture couldn’t be used. Upload it again.', '该图片无法使用,请重新上传。'),
    already_paid:        () => afT('This one has already been rewarded, so it can’t be changed here.', '该记录已发放奖励,无法在此修改。'),
    not_found:           () => afT('That referral is no longer there. Refresh the list.', '该推荐记录已不存在,请刷新列表。'),
    timeout:             () => afT('The server didn’t answer in time. Try again.', '服务器响应超时,请重试。'),
  };
  return map[code] ? map[code]() : (e && e.message) || afT('Something went wrong.', '出现错误。');
}
// Whole numbers read plain (¥630); only fractions show decimals (¥12.50). The
// shared fmt() always forces .00, which reads wrong beside a sentence.
function afxMoney(n) { n = Number(n || 0); return Number.isInteger(n) ? String(n) : n.toFixed(2); }
function afxProgramOn() { return document.body.classList.contains('feat-affiliate'); }
function afxLifeOn(c) { return Number((c || {}).lifetimeRatePercent) > 0; }
function afxNum(v) { const n = parseFloat(String(v).replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : 0; }

// ── the overview read ───────────────────────────────────────────
// One call for everything the top of the page asserts: how many customers hold
// a code, what has been paid against what referred friends spent, and where a
// customer can actually meet the invite.
async function afxLoadOverview() {
  try {
    const r = await api('/api/retail-admin/affiliate/overview');
    AFX.ov = r.data || null;
    AFX.ovErr = '';
  } catch (e) {
    AFX.ov = null;
    AFX.ovErr = afxWhy(e);
  }
  afxRenderHead(); afxRenderVerdict(); afxRenderPlacements();
}

// ── settings load / save ────────────────────────────────────────
function afxBlankCfg() {
  return { rewardPerOrder: 0, rewardReferee: 0, lifetimeRatePercent: 0, lifetimeMonths: 12, lifetimeMode: 'everyone', codePrefix: 'ROOTS-', shareImage: '' };
}
async function afxLoadSettings() {
  AFX.settingsErr = '';
  afxRenderSettings();
  try {
    const r = await api('/api/retail-admin/affiliate/settings');
    const d = r.data || {};
    AFX.cfg = {
      rewardPerOrder:      Number(d.rewardPerOrder) || 0,
      rewardReferee:       Number(d.rewardReferee) || 0,
      lifetimeRatePercent: Number(d.lifetimeRatePercent) || 0,
      // 0 is a real, meaningful value here (no end date) — never fall through to 12.
      lifetimeMonths:      d.lifetimeMonths === 0 ? 0 : (Number(d.lifetimeMonths) || 12),
      // Who earns the ongoing share. Independent of the rate: a shop can sit in
      // selected mode at 5%, and can also build its picked list while still in
      // everyone mode. Anything unrecognised reads as 'everyone', which is the
      // safe direction for a DISPLAY default — the server validates the write.
      lifetimeMode:        d.lifetimeMode === 'selected' ? 'selected' : 'everyone',
      codePrefix:          String(d.codePrefix || 'ROOTS-').toUpperCase(),
      shareImage:          String(d.shareImage || ''),
    };
    AFX.saved = { ...AFX.cfg };
    AFX.settingsErr = '';
  } catch (e) {
    AFX.cfg = AFX.cfg || afxBlankCfg();
    AFX.saved = { ...AFX.cfg };
    AFX.settingsErr = afxWhy(e);
  }
  // Only fetched when the chooser will actually show a count — in everyone mode
  // the picked list is not on screen and reading it would be a request whose
  // answer nothing displays.
  if (AFX.cfg.lifetimeMode === 'selected' && afxLifeOn(AFX.cfg)) afxLoadEligCount();
  afxRenderSettings(); afxRenderOffer(); afxRenderLedger(); afxRenderSaveBar();
}

function afxChanged(keys) {
  if (!AFX.cfg || !AFX.saved) return false;
  return keys.some(k => String(AFX.cfg[k]) !== String(AFX.saved[k]));
}
function afxDirty() { return afxChanged(AFX_SAVE_KEYS); }

async function afxSave() {
  if (AFX.saving || !afxDirty()) return;
  AFX.saving = true; AFX.saveErr = ''; afxRenderSaveBar();
  const before = afxLifeOn(AFX.saved);
  const modeBefore = AFX.saved.lifetimeMode;
  try {
    const r = await api('/api/retail-admin/affiliate/settings', { method: 'PATCH', body: { ...AFX.cfg } });
    const d = r.data || {};
    // Re-read from the server's answer so a clamped value shows what was stored.
    AFX.cfg.codePrefix = String(d.codePrefix || AFX.cfg.codePrefix).toUpperCase();
    AFX.saved = { ...AFX.cfg };
    AFX.saving = false; AFX.saveSaid = true;
    afxRenderSettings(); afxRenderSaveBar();
    setTimeout(() => { AFX.saveSaid = false; afxRenderSaveBar(); }, 2000);
    // The repeat-order share drives a stat tile, a filter pill and a row badge.
    // So does WHO earns it: the three "still earning" figures are all computed
    // server-side against the saved mode, so a mode change makes every one of
    // them stale until the ledger is re-read.
    if (afxLifeOn(AFX.cfg) !== before || AFX.cfg.lifetimeMode !== modeBefore) {
      if (!afxLifeOn(AFX.cfg) && AFX.filter === 'still') { AFX.filter = ''; AFX.page = 1; }
      afxLoadReferrals();
    }
    if (AFX.cfg.lifetimeMode === 'selected' && afxLifeOn(AFX.cfg)) afxLoadEligCount();
    afxRenderOffer(); afxLoadOverview();
  } catch (e) {
    AFX.saving = false;
    AFX.saveErr = afxWhy(e);
    afxRenderSaveBar();
  }
}
function afxDiscard() {
  AFX.cfg = { ...AFX.saved };
  AFX.lifeArm = false; AFX.saveErr = '';
  afxRenderSettings(); afxRenderOffer(); afxRenderSaveBar();
}

// ── program on/off ──────────────────────────────────────────────
// Same config key every other feature page writes (features.affiliate), but
// written from here rather than through setFeatureEnabled() so the page can say
// what happened inline instead of flying a toast in (Marketing precedent #7).
async function afxSetProgram(on) {
  if (AFX.progBusy) return;
  AFX.progBusy = true; afxRenderVerdict();
  try {
    const { data: c } = await api('/api/retail-admin/config', { method: 'PUT', body: { 'features.affiliate': !!on } });
    if (typeof _cfgCache !== 'undefined') _cfgCache = c;
    if (typeof applyFeatureGates === 'function') applyFeatureGates(c);
    if (typeof syncFeatureToggles === 'function') syncFeatureToggles();
    AFX.progErr = '';
  } catch (e) {
    AFX.progErr = afxWhy(e);
  }
  AFX.progBusy = false;
  afxRenderAll();
  afxLoadOverview();
}

// ── the header ──────────────────────────────────────────────────
// Status line first (§1.7): a real number, and the one that matters here is
// how many people are carrying a code versus how many have used one. The Dusk
// CTA is rendered ONLY when there is something to do about it — once the invite
// is on the home layout the slot is empty, which the header contract allows.
function afxRenderHead() {
  const line = $('#afx-statusline');
  const cta = $('#afx-headcta');
  const o = AFX.ov;
  if (line) {
    line.textContent = !o ? ''
      : !afxProgramOn() ? afT('The program is off', '推荐计划已关闭')
      : o.counts.referrals === 0
        ? afT(o.customers.withCode + ' customers hold a code · none has used one',
              o.customers.withCode + ' 位顾客持有邀请码 · 尚无人使用')
        : afT(o.customers.withCode + ' customers hold a code · ' + o.counts.referrals + ' used',
              o.customers.withCode + ' 位顾客持有邀请码 · ' + o.counts.referrals + ' 次使用');
  }
  if (cta) {
    cta.innerHTML = (o && afxProgramOn() && !o.placements.onHome)
      ? `<button class="afx-btn dusk" data-afx="go-home-layout">${afT('Put the invite on the home screen', '把邀请放到首页')}</button>`
      : '';
  }
}

// ── the verdict: what the page is actually for ──────────────────
function afxFig(k, v, s) {
  return `<div class="afx-fig"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
}
function afxRenderVerdict() {
  const host = $('#afx-verdict'); if (!host) return;
  const o = AFX.ov;

  if (!afxProgramOn()) {
    host.innerHTML = `<div class="afx-verdict">
        <div class="lead">${afT('The referral program is off.', '推荐计划已关闭。')}</div>
        <div class="sub">${afT(
          'Customers can’t join, share codes, or earn — the Refer a friend page is hidden in your shop. Anyone mid-referral keeps their history, and rewards already in wallets stay.',
          '顾客无法加入、分享邀请码或获得奖励 — 店内的“推荐好友”页面已隐藏。正在推荐中的顾客保留记录,已入钱包的奖励不受影响。')}</div>
        <div style="margin-top: 24px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap">
          <button class="afx-btn ink" data-afx="program-on" ${AFX.progBusy ? 'disabled' : ''}>${
            AFX.progBusy ? `<span class="afx-spin"></span>${afT('Turning on…', '开启中…')}` : afT('Turn it on', '开启')}</button>
          ${AFX.progErr ? `<span style="font-size: 13px; color: var(--td-brick-ink)">${escapeHtml(AFX.progErr)}</span>` : ''}
        </div>
      </div>`;
    return;
  }

  if (!o) {
    host.innerHTML = `<div class="afx-verdict"><div class="afx-figs" style="margin-top: 0; padding-top: 0; border-top: 0">${
      [afT('Paid out', '已发出'), afT('Referred friends have spent', '被推荐好友消费'), afT('Each referral costs', '每次推荐成本')]
        .map(k => `<div class="afx-fig"><div class="k">${k}</div><div class="skel"></div></div>`).join('')}</div></div>`;
    return;
  }

  const withCode = o.customers.withCode;
  const used = o.counts.referrals;
  const lead = used === 0
    ? afT(withCode + ' customers are carrying a referral code. None of them has used it.',
          withCode + ' 位顾客持有邀请码,尚无人使用。')
    : used === 1
      ? afT(withCode + ' customers are carrying a referral code. One of them has used it.',
            withCode + ' 位顾客持有邀请码,其中 1 位使用过。')
      : afT(withCode + ' customers are carrying a referral code. ' + used + ' have used one.',
            withCode + ' 位顾客持有邀请码,其中 ' + used + ' 位使用过。');

  // The honest second sentence depends on what is actually in the way. Placement
  // first — a code nobody can find is the only explanation worth offering before
  // the offer itself is questioned.
  const sub = !o.placements.onHome
    ? afT('The offer is live and the codes exist. What is missing is somewhere for a customer to see the invite — it is not on your home screen.',
          '奖励已生效,邀请码也已发出。缺的是让顾客看到邀请的位置 — 首页上没有它。')
    : used === 0
      ? afT('The invite is on the home screen and the codes exist. Nobody has shared one yet.',
            '邀请已在首页,邀请码也已发出,但还没有人分享。')
      : afT('Rewards are paid automatically the moment a friend’s first order is marked paid.',
            '好友首单标记为已付款时,奖励自动发放。');

  const cost = Number(o.offer.referrer) + Number(o.offer.friend);
  const paid = Number(o.money.paidOut);
  const spend = Number(o.money.friendSpend);
  const figs =
    afxFig(afT('You have paid out', '已发出奖励'), acWrap(afxMoney(paid)),
           paid > 0
             ? (o.money.lifetimePaid > 0
                 ? afT('incl. ' + acWrap(afxMoney(o.money.lifetimePaid)) + ' from repeat orders', '含复购分成 ' + acWrap(afxMoney(o.money.lifetimePaid)))
                 : afT('to referrer and friend wallets', '进入推荐人与好友钱包'))
             : afT('no referral has converted', '尚无推荐达成')) +
    afxFig(afT('Referred friends have spent', '被推荐好友消费'), acWrap(afxMoney(spend)),
           spend > 0
             ? afT('since they joined', '自加入起')
             : afT('nothing to weigh it against', '暂无可对比的数字')) +
    afxFig(afT('Each referral costs', '每次推荐成本'), acWrap(afxMoney(cost)),
           afT(acWrap(afxMoney(o.offer.referrer)) + ' to them, ' + acWrap(afxMoney(o.offer.friend)) + ' to the friend',
               '推荐人 ' + acWrap(afxMoney(o.offer.referrer)) + ',好友 ' + acWrap(afxMoney(o.offer.friend))));

  host.innerHTML = `<div class="afx-verdict">
      <div class="lead">${lead}</div>
      <div class="sub">${sub}</div>
      <div class="afx-figs">${figs}</div>
    </div>`;
}

// ── where a customer can find it ────────────────────────────────
// Read from the LIVE mini-app config, never the CMS draft — what a customer can
// reach today is the only version of this worth reporting.
function afxRenderPlacements() {
  const host = $('#afx-placements'); if (!host) return;
  const o = AFX.ov;
  if (!o || !afxProgramOn()) { host.innerHTML = ''; return; }
  const p = o.placements;

  const pill = (kind, label) => `<span class="afx-pill ${kind}">${label}</span>`;
  const row = (t, s, right) => `<div class="afx-place"><div class="pt"><div class="t">${t}</div><div class="s">${s}</div></div>${right}</div>`;

  const me = p.mePage.enabled
    ? row(afT('Me tab', '“我的”页面'),
          afT('Row ' + p.mePage.position + ' of ' + p.mePage.total + ' on the account screen.',
              '账户页第 ' + p.mePage.position + ' 行,共 ' + p.mePage.total + ' 行。'),
          pill('sage', afT('Showing', '展示中')))
    : row(afT('Me tab', '“我的”页面'),
          afT('The row exists but is switched off.', '该入口存在,但已关闭。'),
          pill('neutral', afT('Hidden', '已隐藏')));

  const home = p.onHome
    ? row(afT('Home screen', '首页'),
          afT('An invite block is on the live layout.', '首页布局中已有邀请模块。'),
          pill('sage', afT('Showing', '展示中')))
    : row(afT('Home screen', '首页'),
          afT('The first thing every customer sees. There is no invite block on it.',
              '每位顾客最先看到的页面,目前没有邀请模块。'),
          pill('brick', afT('Not there', '未添加')) +
          `<button class="afx-link" data-afx="go-home-layout">${afT('Add one in the Mini App Editor', '在小程序编辑器中添加')}</button>`);

  host.innerHTML = `<div class="afx-card" style="margin-top: 24px">
      <div class="afx-card-lbl">${afT('Where a customer can find it', '顾客在哪里能看到')}</div>
      ${row(afT('Refer a friend page', '推荐好友页面'),
            afT('The program’s home in your shop. It cannot be turned off separately.', '推荐计划在店内的主页面,无法单独关闭。'),
            pill('neutral', afT('Always on', '始终开启')))}
      ${me}
      ${home}
    </div>`;
}

// ── the offer, as one line you can open ─────────────────────────
function afxRenderOffer() {
  const host = $('#afx-offer'); if (!host) return;
  if (!AFX.cfg || !afxProgramOn()) { host.innerHTML = ''; return; }
  const c = AFX.cfg;
  const life = afxLifeOn(c);
  const tail = life
    ? afT(', plus ' + c.lifetimeRatePercent + '% of what the friend spends' +
            (Number(c.lifetimeMonths) === 0 ? ' for as long as they keep buying' : ' for ' + c.lifetimeMonths + ' months'),
          ',另加好友消费额的 ' + c.lifetimeRatePercent + '%' +
            (Number(c.lifetimeMonths) === 0 ? ',不设期限' : ',持续 ' + c.lifetimeMonths + ' 个月'))
    : '';
  // In selected mode this sentence would otherwise read as the offer EVERY
  // customer gets, which is exactly what it stopped being.
  //
  // Both halves are CONTINUING CLAUSES — one opens on an em dash, the other on
  // a comma — so each is spliced in BEFORE its sentence's terminator, not
  // appended after it. Appended, they read "…for 12 months. — the ongoing
  // share…" and "…个月。，持续分成…": a full stop with a clause hanging off
  // it. That also means the two languages cannot share one resolved string, so
  // the halves stay separate here and each sentence is assembled in full below.
  // The locked tail above is untouched either way.
  const sel = life && c.lifetimeMode === 'selected';
  const qualEn = sel ? ' — the ongoing share for chosen customers only' : '';
  const qualCn = sel ? '，复购分成仅限指定客户' : '';
  host.innerHTML = `<div class="afx-card" style="margin-top: 24px">
      <div class="afx-offerline">
        <div class="ot">
          <div class="afx-card-lbl" style="margin-bottom: 0">${afT('The offer', '奖励方案')}</div>
          <div class="h">${afT('Give ' + acWrap(afxMoney(c.rewardReferee)) + ', get ' + acWrap(afxMoney(c.rewardPerOrder)) + tail + qualEn + '.',
                               '给出 ' + acWrap(afxMoney(c.rewardReferee)) + ',获得 ' + acWrap(afxMoney(c.rewardPerOrder)) + tail + qualCn + '。')}</div>
          <div class="s">${afT('Paid into the referrer’s wallet the moment a friend’s first order is marked paid.',
                               '好友首单标记为已付款时,奖励即刻进入推荐人钱包。')}</div>
        </div>
        <button class="afx-btn sec" data-afx="settings-toggle">${
          AFX.settingsOpen ? afT('Done', '完成') : afT('Change the offer', '修改方案')}</button>
      </div>
    </div>`;
}

// ── settings column ─────────────────────────────────────────────
// An inline field that sits inside a sentence. `cur` renders before the number
// (¥), `suffix` after it (%), and `wide` is the text variant (code prefix).
function afxField(key, value, opts) {
  const o = opts || {};
  const cls = ['afx-amt', o.suffix ? 'suffix' : '', o.wide ? 'wide' : ''].filter(Boolean).join(' ');
  const affix = o.suffix || o.prefix || '';
  return `<span class="${cls}">${affix ? `<span class="cur">${affix}</span>` : ''}<input
      data-afx-field="${key}" value="${escapeAttr(String(value))}"
      inputmode="${o.wide ? 'text' : 'decimal'}" spellcheck="false"
      aria-label="${escapeAttr(o.label || key)}"></span>`;
}

function afxRenderSettings() {
  const host = $('#afx-settings'); if (!host) return;
  if (!AFX.cfg) { host.innerHTML = ''; return; }
  const c = AFX.cfg;
  const life = afxLifeOn(c);

  if (AFX.settingsErr) {
    host.innerHTML = `<div class="afx-col"><div class="afx-card"><div class="afx-state" style="padding:48px 24px">
        <div class="ei">${AFX_I.alert}</div>
        <h3>${afT('Couldn’t load these settings.', '加载设置失败。')}</h3>
        <p>${escapeHtml(AFX.settingsErr)}<br>${afT('Nothing was changed. Past referrals below still load.', '设置未被修改。下方的推荐记录仍会加载。')}</p>
        <button class="afx-btn sec" data-afx="reload-settings">${AFX_I.refresh}${afT('Try again', '重试')}</button>
      </div></div></div>`;
    return;
  }

  // ── the offer ──
  const offer = `<div class="afx-card">
      <div class="afx-card-lbl">${afT('The offer', '奖励方案')}</div>
      <div class="afx-lead">${afT('When a friend places their first paid order:', '当好友完成首笔付费订单时:')}</div>
      <div class="afx-sent">
        <span class="who">${afT('the friend gets', '好友获得')}</span>${afxField('rewardReferee', c.rewardReferee, { prefix: acCurrencySymbol(), label: afT('Reward for the friend', '好友奖励') })}<span class="who">${afT('in store credit', '店铺余额')}</span>
        <span class="who"> · </span>
        <span class="who">${afT('the referrer gets', '推荐人获得')}</span>${afxField('rewardPerOrder', c.rewardPerOrder, { prefix: acCurrencySymbol(), label: afT('Reward for the referrer', '推荐人奖励') })}<span class="who">${afT('in store credit', '店铺余额')}</span>
      </div>
      <div class="afx-restate" id="afx-restate">${afxRestate()}</div>
      <div class="afx-note">${afT(
        'Paid out automatically. Rewards land in the referrer’s wallet the moment a friend’s first order is marked paid — you only step in to void.',
        '自动发放。好友首单标记为已付款时,奖励即刻进入推荐人钱包 — 您只需在必要时作废。')}</div>
    </div>`;

  // ── repeat orders (lifetime share) ──
  const arm = AFX.lifeArm
    ? `<div class="afx-confirm">
         <p>${afT('This pays referrers a share of every future order their friends place.',
                  '这会让推荐人从好友之后的每一笔订单中持续获得分成。')}</p>
         <div class="row">
           <button class="afx-btn ink sm" data-afx="life-confirm">${afT('Confirm', '确认')}</button>
           <button class="afx-btn ghost sm" data-afx="life-cancel">${afT('Cancel', '取消')}</button>
         </div>
       </div>` : '';
  const lifeBody = life
    ? `<div class="afx-optin-body">${afT('The referrer also earns', '推荐人还可获得好友消费额的')}${afxField('lifetimeRatePercent', c.lifetimeRatePercent, { suffix: '%', label: afT('Share of repeat orders', '复购分成比例') })}${afT('of everything their friend spends, for', '作为分成,持续')}${afxField('lifetimeMonths', c.lifetimeMonths, { label: afT('Months the share lasts', '分成持续月数') })}${afT('months after joining.', '个月(自好友加入起算)。')}
         <div class="afx-note" id="afx-life-note">${afxLifeNote()}</div>
       </div>` : '';
  // The mode chooser lives UNDER the switch and only while the switch is on:
  // it answers "who earns it", which is not a question until something is being
  // earned. Off, it would be a live control over a dormant feature.
  const modeSel = c.lifetimeMode === 'selected';
  const modeBlock = life
    ? `<div class="afx-mode">
         <div class="ml">${afT('Who earns it', '谁可获得')}</div>
         <div class="afx-seg">
           <button class="${modeSel ? '' : 'on'}" data-afx="mode:everyone">${afT('Everyone', '所有人')}</button>
           <button class="${modeSel ? 'on' : ''}" data-afx="mode:selected">${afT('Selected customers', '指定客户')}</button>
         </div>
         ${modeSel
           ? `<div class="afx-mode-manage">
                <button class="afx-btn sec sm" data-afx="manage-eligible">${afT('Choose who earns it', '选择可获得的客户')}</button>
                <span class="mc">${AFX.eligCount === null
                    ? afT('Counting…', '统计中…')
                    : (AFX.eligCount === 1 ? afT('1 customer chosen', '已选 1 位客户')
                                           : afT(AFX.eligCount + ' customers chosen', '已选 ' + AFX.eligCount + ' 位客户'))}</span>
              </div>
              <div class="afx-note">${afT('Everyone else still earns the one-time referral reward. Choosing someone starts them earning from that moment — it never pays them for orders placed before you chose them.',
                  '其他客户仍可获得一次性推荐奖励。选定某位客户后，从选定当刻起开始计算分成，此前的订单不会补发。')}</div>`
           : `<div class="afx-note">${afT('Any customer who refers a friend earns the ongoing share.', '任何推荐好友的客户都可获得复购分成。')}</div>`}
       </div>`
    : '';
  const repeat = `<div class="afx-card">
      <div class="afx-optin">
        <div class="afx-optin-t">
          <div class="h">${afT('Keep rewarding repeat orders', '持续奖励复购')}</div>
          <div class="s">${afT('Reward the referrer on their friend’s later orders, not just the first.',
                               '不止首单 — 好友之后的订单也让推荐人获得分成。')}</div>
        </div>
        <button class="afx-sw${life ? ' on' : ''}" role="switch" aria-checked="${life}"
                aria-label="${afT('Keep rewarding repeat orders', '持续奖励复购')}" data-afx="life"></button>
      </div>${arm}${lifeBody}${modeBlock}</div>`;

  // ── invite codes ──
  const codes = `<div class="afx-card">
      <div class="afx-card-lbl">${afT('Invite codes', '邀请码')}</div>
      <div class="afx-sent">${afT('Every customer’s code starts with', '每位顾客的邀请码都以')}${afxField('codePrefix', c.codePrefix, { wide: true, label: afT('Code prefix', '邀请码前缀') })}${afT('', '开头')}</div>
      <div class="afx-note">${afT(
        'Letters, numbers and dashes, up to 12 characters. Codes already given out keep the prefix they were issued with.',
        '可用字母、数字和短横线,最多 12 个字符。已发出的邀请码保留原有前缀。')}</div>
    </div>`;

  // ── share picture ──
  const url = c.shareImage;
  const thumb = url
    ? `<img src="${escapeAttr(url)}" alt="">`
    : `<span class="ph">${afT('No picture yet', '尚未设置图片')}</span>`;
  const removeBtn = url
    ? `<button class="afx-btn ghost sm" data-afx="pic-remove">${afT('Remove picture', '移除图片')}</button>` : '';
  const share = `<div class="afx-card">
      <div class="afx-card-lbl">${afT('Share picture', '分享图片')}</div>
      <div class="afx-share-row">
        <div class="afx-share-thumb">${thumb}</div>
        <div class="afx-share-ctl">
          <div class="afx-share-actions">
            <button class="afx-btn sec sm" data-afx="pic-replace" ${AFX.uploading ? 'disabled' : ''}>${
              AFX.uploading ? `<span class="afx-spin"></span>${afT('Uploading…', '上传中…')}`
                            : (url ? afT('Replace picture', '更换图片') : afT('Add a picture', '添加图片'))}</button>
            ${removeBtn}
          </div>
          <div class="afx-note" style="margin-top:0">${afT(
            'The picture a customer sees when forwarding their invite. Wide shape (5:4). The amount and the code are added as text — leave them out of the picture. With none set, the built-in one is used.',
            '顾客转发邀请时看到的图片。建议 5:4 宽幅。金额与邀请码会自动叠加为文字,请勿放进图片。未设置时使用内置图片。')}</div>
          ${AFX.picErr ? `<div class="afx-note" style="color:var(--td-brick-ink)">${escapeHtml(AFX.picErr)}</div>` : ''}
        </div>
      </div>
    </div>`;

  // Turning the whole program off is rare and consequential, so it lives at the
  // bottom of the settings disclosure rather than on the page — but it has to
  // live SOMEWHERE, and this page is now its only home.
  const program = `<div class="afx-card">
      <div class="afx-optin">
        <div class="afx-optin-t">
          <div class="h">${afT('Referral program', '推荐计划')}</div>
          <div class="s">${afT('Turning it off hides the Refer a friend page. Anyone mid-referral keeps their history, and rewards already in wallets stay.',
                               '关闭后将隐藏“推荐好友”页面。正在推荐中的顾客保留记录,已入钱包的奖励不受影响。')}</div>
        </div>
        <button class="afx-sw on" role="switch" aria-checked="true"
                aria-label="${afT('Referral program', '推荐计划')}"
                ${AFX.progBusy ? 'disabled' : ''} data-afx="program-off"></button>
      </div>
      ${AFX.progErr ? `<div class="afx-note" style="color: var(--td-brick-ink)">${escapeHtml(AFX.progErr)}</div>` : ''}
    </div>`;

  host.innerHTML = `<div class="afx-col">${offer}${repeat}${codes}${share}${program}</div>`;
}

// ── who earns the ongoing share ───────────────────────────────
// The picked list is a roster, not a setting: each pick writes immediately and
// is live the moment it lands. It is deliberately NOT held behind the save bar
// — an operator who builds a list, then hits Discard because they changed their
// mind about the RATE, must not silently lose the list too.
async function afxLoadEligCount() {
  try {
    const r = await api('/api/retail-admin/affiliate/eligible');
    AFX.eligCount = Number((r.data || {}).count) || 0;
  } catch (e) {
    // A count that could not be read must not render as "0 chosen" — that reads
    // as a fact about the shop rather than a failed request. null renders as
    // "Counting…" and the operator can open the dialog, which says more.
    AFX.eligCount = null;
  }
  afxRenderSettings();
}

// One customer in or out. Returns the fresh count so the caller can repaint
// without a second read.
async function afxEligSet(customerId, eligible) {
  const r = await api('/api/retail-admin/affiliate/eligible', {
    method: 'POST', body: { customerId, eligible },
  });
  AFX.eligCount = Number((r.data || {}).count) || 0;
  return r.data;
}

// The manage dialog. askCustom() mounts on <body> at z-2000, which is the only
// reason this works at all: #tab-affiliate's entrance animation makes it a
// stacking context, so a modal authored inside the section paints BEHIND the
// page chrome (the same trap the Customers pop-ups documented and escaped).
// Every class inside is afxel- prefixed and styled at body level — a
// '#tab-affiliate .afx-' rule cannot reach here.
async function afxOpenEligible() {
  const dlg = askCustom('', `
    <div class="afxel-wrap">
      <div>
        <div class="afxel-h">${afT('Who earns the ongoing share', '谁可获得复购分成')}</div>
        <div class="afxel-sub">${afT('Only these customers earn a share of their friends’ later orders. Everyone else still earns the one-time referral reward. Each change takes effect straight away.',
            '仅以下客户可从好友之后的订单中获得分成。其他客户仍可获得一次性推荐奖励。每项更改立即生效。')}</div>
      </div>
      <label class="afxel-find">${AFX_I.search}<input data-afxel-q
        placeholder="${escapeAttr(afT('Find a customer by name, phone or code', '按姓名、手机号或推荐码查找客户'))}"></label>
      <div class="afxel-list" data-afxel-list></div>
    </div>`,
    `<button class="tdlg-btn tdlg-btn--primary" data-afxel-close>${afT('Done', '完成')}</button>`,
    '[data-afxel-q]');

  const listEl = dlg.scrim.querySelector('[data-afxel-list]');
  const qEl    = dlg.scrim.querySelector('[data-afxel-q]');
  let mode = 'chosen';    // 'chosen' = the picked list | 'search' = candidates to add
  let rows = [];
  let note = '';

  const nameOf = (r) => escapeHtml(r.nickname || afT('No name', '未填姓名'));
  const metaOf = (r) => escapeHtml([r.phone, r.referral_code].filter(Boolean).join(' · '));

  function paint() {
    if (!rows.length) {
      listEl.innerHTML = `<div class="afxel-empty">${escapeHtml(
        mode === 'search'
          ? afT('Nobody found. Try a different name, phone or code.', '未找到客户。请尝试其他姓名、手机号或推荐码。')
          : afT('Nobody is chosen yet. Search above to add someone.', '尚未选择任何客户。请在上方搜索添加。'))}</div>`;
      return;
    }
    listEl.innerHTML = rows.map(r => `<div class="afxel-row" data-afxel-row="${r.id}">
        <span class="n">${nameOf(r)}${metaOf(r) ? ` <span class="d">${metaOf(r)}</span>` : ''}</span>
        <button ${AFX.eligBusy ? 'disabled' : ''} data-afxel-set="${r.id}" data-afxel-on="${mode === 'search' ? '1' : '0'}">${
          escapeHtml(mode === 'search' ? afT('Add', '添加') : afT('Remove', '移除'))}</button>
      </div>`).join('') + (note ? `<div class="afxel-empty">${escapeHtml(note)}</div>` : '');
  }

  async function loadChosen() {
    mode = 'chosen'; note = '';
    listEl.innerHTML = `<div class="afxel-empty">${escapeHtml(afT('Loading…', '加载中…'))}</div>`;
    try {
      const r = await api('/api/retail-admin/affiliate/eligible');
      rows = (r.data && r.data.rows) || [];
      AFX.eligCount = Number((r.data || {}).count) || 0;
      // Say what was left out rather than showing a short list as if complete.
      if (r.data && r.data.truncated) note = afT('Showing the ' + rows.length + ' most recently chosen of ' + AFX.eligCount + '.',
        '共 ' + AFX.eligCount + ' 位，显示最近选定的 ' + rows.length + ' 位。');
      afxRenderSettings();
    } catch (e) {
      rows = [];
      listEl.innerHTML = `<div class="afxel-empty">${escapeHtml(afxWhy(e))}</div>`;
      return;
    }
    paint();
  }

  async function search(q) {
    mode = 'search'; note = '';
    try {
      const r = await api('/api/retail-admin/affiliate/eligible/search?q=' + encodeURIComponent(q));
      rows = r.data || [];
    } catch (e) { rows = []; note = afxWhy(e); }
    paint();
  }

  let t = null;
  qEl.addEventListener('input', () => {
    clearTimeout(t);
    const q = qEl.value.trim();
    t = setTimeout(() => { if (q.length >= 2) search(q); else loadChosen(); }, 250);
  });

  listEl.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-afxel-set]');
    if (!btn || AFX.eligBusy) return;
    const id = Number(btn.getAttribute('data-afxel-set'));
    const on = btn.getAttribute('data-afxel-on') === '1';
    AFX.eligBusy = true; btn.disabled = true;
    try {
      await afxEligSet(id, on);
      // Adding from search removes the row from that list (it is now chosen, and
      // offering to add them again is a control that can only be wrong).
      // Removing from the chosen list does the same, for the same reason.
      rows = rows.filter(r => r.id !== id);
      afxRenderSettings();
      paint();
    } catch (e) {
      note = afxWhy(e);
      paint();
    } finally { AFX.eligBusy = false; }
  });

  dlg.scrim.querySelector('[data-afxel-close]').addEventListener('click', () => dlg.closer(true));
  loadChosen();
  await dlg.ready;
  // The count on the card is the one figure that must match this dialog, so it
  // is re-read on close rather than trusted to the running tally.
  afxLoadEligCount();
}

function afxRestate() {
  const c = AFX.cfg || {};
  return afT('Give <b>' + acWrap(afxMoney(c.rewardReferee)) + '</b>, get <b>' + acWrap(afxMoney(c.rewardPerOrder)) + '</b>.',
             '给出 <b>' + acWrap(afxMoney(c.rewardReferee)) + '</b>,获得 <b>' + acWrap(afxMoney(c.rewardPerOrder)) + '</b>。');
}
// 0 months is a real setting, not an empty field — say what it does (the dash
// and the silent "reloads as 12" flip are both banned).
function afxLifeNote() {
  const c = AFX.cfg || {};
  return Number(c.lifetimeMonths) === 0
    ? afT('Set to 0 months, the share has no end date — the referrer keeps earning from that friend for good.',
          '设为 0 个月即不设期限 — 推荐人将一直从该好友的订单中获得分成。')
    : afT('Counted from the day the friend joined. Set 0 months for no end date. Nothing is clawed back when the window closes.',
          '自好友加入当天起算。设为 0 即不设期限。周期结束后不会追回已发放的分成。');
}

// ── ledger ──────────────────────────────────────────────────────
// "Still earning" only exists while the repeat-order share is on, so the pill
// only exists then either — a filter that can only ever return nothing is not
// a filter. Counts come from the summary, which is unfiltered on purpose.
function afxFilters() {
  const f = [
    ['',        afT('All', '全部'),      s => Number(s.total || 0)],
    ['joined',  afT('Waiting', '待首单'),  s => Number(s.joined || 0)],
    ['ordered', afT('Rewarded', '已奖励'), s => Number(s.converted || 0)],
    ['void',    afT('Voided', '已作废'),   s => Number(s.voided || 0)],
  ];
  if (afxLifeOn(AFX.saved)) f.push(['still', afT('Still earning', '持续分成'), s => Number(s.still_earning || 0)]);
  return f;
}

let _afxSearchT = null;
function afxSearchLater() {
  clearTimeout(_afxSearchT);
  _afxSearchT = setTimeout(() => { AFX.page = 1; afxLoadReferrals(); }, 250);
}

async function afxLoadReferrals() {
  AFX.ledger = 'loading';
  AFX.rowConfirm = null;
  afxRenderLedger();
  const qs = new URLSearchParams();
  if (AFX.filter) qs.set('status', AFX.filter);
  if (AFX.query) qs.set('q', AFX.query);
  qs.set('page', String(AFX.page));
  qs.set('pageSize', String(AFX_PAGE_SIZE));
  try {
    const r = await api('/api/retail-admin/affiliate/referrals?' + qs.toString());
    AFX.rows = r.data || [];
    AFX.summary = r.summary || null;
    AFX.total = Number(r.total || 0);
    AFX.ledgerErr = '';
    // An emptied-out page is not an empty result: void the last row on page 3
    // and the server honestly returns nothing for page 3. Step back rather
    // than telling the operator their filter matched nothing.
    const lastPage = Math.max(1, Math.ceil(AFX.total / AFX_PAGE_SIZE));
    if (!AFX.rows.length && AFX.total > 0 && AFX.page > 1 && lastPage < AFX.page) {
      AFX.page = lastPage;
      return afxLoadReferrals();     // lastPage < page, so this always terminates
    }
    AFX.ledger = AFX.rows.length ? 'ok'
      : (AFX.filter || AFX.query) ? 'nomatch'
      : 'empty';
  } catch (e) {
    AFX.rows = []; AFX.total = 0;
    AFX.ledgerErr = afxWhy(e);
    AFX.ledger = 'error';
  }
  afxRenderLedger();
}

function afxStatusCell(r) {
  if (r.status === 'void')    return `<span class="afx-st"><span class="afx-pill brick">${afT('Voided', '已作废')}</span></span>`;
  // A 'joined' row whose friend has already paid for something can never
  // convert — the first-order bounty has had its chance. Saying "Waiting" here
  // is the page claiming a future that will not arrive.
  if (r.blocked) {
    return `<span class="afx-st"><span class="afx-pill brick">${afT('Can’t be rewarded', '无法发放')}</span></span>` +
      `<div class="afx-why">${afT(
        'This friend had already bought from you before the code was used, so it was not a first order. Nothing will change on its own.',
        '该好友在使用邀请码之前已经下过单,因此不算首单。此状态不会自行改变。')}</div>`;
  }
  if (r.status === 'joined')  return `<span class="afx-st"><span class="afx-pill amber">${afT('Waiting', '待首单')}</span></span>`;
  // Graphite/neutral, not Dusk — "Still earning" is state, and the page's one
  // Dusk element is Save changes.
  const still = r.lifetime_active
    ? `<span class="afx-pill neutral">${afT('Still earning', '持续分成')}</span>` : '';
  return `<span class="afx-st"><span class="afx-pill sage">${afT('Rewarded', '已奖励')}</span>${still}</span>`;
}

// Only offer what the server will actually accept. A rewarded referral cannot
// be voided (the wallet credit is already spent) — showing a button that comes
// back 409 is the page claiming something untrue.
function afxActionCell(r) {
  const off = AFX.rowBusy ? ' disabled' : '';    // §1.12 — no second click while one is in flight
  if (r.status === 'joined') return `<button class="afx-btn ghost sm"${off} data-afx="void:${r.id}">${
    r.blocked ? afT('Close it', '关闭') : afT('Void', '作废')}</button>`;
  if (r.status === 'void')   return `<button class="afx-btn ghost sm"${off} data-afx="restore:${r.id}">${afT('Restore', '恢复')}</button>`;
  return '';
}

function afxRow(r) {
  if (AFX.rowConfirm && AFX.rowConfirm.id === r.id) return afxRowConfirm(r);
  // WeChat nicknames are optional, and "#231" tells the operator nothing they
  // can act on. The phone is what they would actually search a customer by.
  const who = (nick, phone, id) => escapeHtml(nick || phone || ('#' + id));
  const referrer = who(r.referrer_nickname, r.referrer_phone, r.referrer_id);
  const friend   = who(r.invitee_nickname,  r.invitee_phone,  r.invitee_id);
  const ordered = r.status === 'ordered' || !!r.first_paid_order_id;
  const when = ordered ? (tdWhen(r.rewarded_at || r.joined_at, 'date') || '') : '';
  const first = !ordered ? `<span class="afx-dim">${afT('Not yet', '尚未下单')}</span>`
    : when ? `<span class="afx-num">${escapeHtml(when)}</span>`
    : `<span class="afx-dim">${afT('Date not recorded', '未记录日期')}</span>`;
  const joined = tdWhen(r.joined_at, 'date') || '';
  const date = joined ? `<span class="afx-num">${escapeHtml(joined)}</span>`
    : `<span class="afx-dim">${afT('Date not recorded', '未记录日期')}</span>`;
  // reward_amount is what the row is HOLDING IN RESERVE, not what was paid —
  // it is set when the referral is created and survives whatever happens next.
  // Only an 'ordered' row ever moved money, so every other row earned ¥0.
  // Printing the reserved figure under a heading that says "Earned" was the
  // page claiming a payment that never happened.
  const paid = r.status === 'ordered' ? (Number(r.reward_amount) || 0) : 0;
  const earned = paid > 0
    ? `<span class="afx-num">${acWrap(afxMoney(paid))}</span>`
    : `<span class="afx-dim afx-num">${acWrap(afxMoney(0))}</span>`;
  return `<tr>
      <td><a data-afx="cust:${r.referrer_id}">${referrer}</a></td>
      <td><a data-afx="cust:${r.invitee_id}">${friend}</a></td>
      <td style="vertical-align: top">${afxStatusCell(r)}</td>
      <td><span class="afx-dim">${escapeHtml(r.code_used || '')}</span></td>
      <td>${date}</td>
      <td>${first}</td>
      <td class="num">${earned}</td>
      <td class="act">${afxActionCell(r)}</td>
    </tr>`;
}

function afxRowConfirm(r) {
  const c = AFX.rowConfirm;
  const busy = AFX.rowBusy;
  // A blocked row was never going to pay out, so the warning that fits an open
  // referral would be false here. Closing it is bookkeeping, not a decision.
  const blocked = !!(AFX.rows.find(x => x.id === c.id) || {}).blocked;
  const body = c.kind === 'void'
    ? `<p>${blocked
        ? afT('Close this referral? It can’t be rewarded either way — this only takes it off the list.',
              '关闭这条推荐记录?它本来就无法发放奖励,此操作只是把它从列表中移除。')
        : afT('Void this referral? The referrer won’t be rewarded when this friend places their first order.',
              '作废这条推荐记录?该好友首单时,推荐人将不会获得奖励。')}</p>
       <div class="row">
         <input class="afx-reason" data-afx-reason value="${escapeAttr(c.reason || '')}"
                placeholder="${afT('Why (kept on the record)', '原因(将记录在案)')}">
         <button class="afx-btn ink sm" data-afx="void-yes:${r.id}" ${busy ? 'disabled' : ''}>${
           busy ? `<span class="afx-spin"></span>${afT('Voiding…', '作废中…')}` : afT('Void', '作废')}</button>
         <button class="afx-btn ghost sm" data-afx="row-cancel" ${busy ? 'disabled' : ''}>${afT('Cancel', '取消')}</button>
       </div>`
    : `<p>${afT('Restore this referral? It goes back to waiting for a first order.',
                '恢复这条推荐记录?它将回到“待首单”状态。')}</p>
       <div class="row">
         <button class="afx-btn ink sm" data-afx="restore-yes:${r.id}" ${busy ? 'disabled' : ''}>${
           busy ? `<span class="afx-spin"></span>${afT('Restoring…', '恢复中…')}` : afT('Restore', '恢复')}</button>
         <button class="afx-btn ghost sm" data-afx="row-cancel" ${busy ? 'disabled' : ''}>${afT('Cancel', '取消')}</button>
       </div>`;
  const err = c.err ? `<p style="color:var(--td-brick-ink);margin-top:16px;margin-bottom:0">${escapeHtml(c.err)}</p>` : '';
  return `<tr><td colspan="8" class="afx-rowconfirm"><div class="in">${body}${err}</div></td></tr>`;
}

function afxLedgerBody() {
  if (AFX.ledger === 'error') {
    return `<div class="afx-tblcard"><div class="afx-state">
        <div class="ei">${AFX_I.alert}</div>
        <h3>${afT('Couldn’t load referrals.', '加载推荐记录失败。')}</h3>
        <p>${escapeHtml(AFX.ledgerErr)}<br>${afT('Your settings are safe — they load separately.', '设置不受影响 — 它们单独加载。')}</p>
        <button class="afx-btn sec" data-afx="refresh">${AFX_I.refresh}${afT('Try again', '重试')}</button>
      </div></div>`;
  }
  // Only the FIRST load gets a loading card. A reload holds the rows it already
  // has, dimmed — otherwise the table blinks out from under the operator on
  // every keystroke of the search box.
  if (AFX.ledger === 'loading' && !AFX.rows.length) {
    return `<div class="afx-tblcard"><div class="afx-state"><p>${afT('Loading…', '加载中…')}</p></div></div>`;
  }
  if (AFX.ledger === 'empty') {
    return `<div class="afx-tblcard"><div class="afx-state">${AFX_I.wave}
        <h3>${afT('No referrals yet.', '暂无推荐记录。')}</h3>
        <p>${afT('When a customer shares their code and a friend joins, they show up here.', '当顾客分享邀请码、好友加入后,记录会出现在这里。')}</p>
      </div></div>`;
  }
  if (AFX.ledger === 'nomatch') {
    return `<div class="afx-tblcard"><div class="afx-state">
        <h3>${afT('Nothing matches.', '没有匹配项。')}</h3>
        <p>${afT('Try a different filter, or clear the search.', '换个筛选条件,或清空搜索。')}</p>
      </div></div>`;
  }

  const pages = Math.max(1, Math.ceil(AFX.total / AFX_PAGE_SIZE));
  const from = (AFX.page - 1) * AFX_PAGE_SIZE + 1;
  const to = Math.min(AFX.total, from + AFX.rows.length - 1);
  const pagi = `<div class="afx-pagi">
      <span>${afT('Showing', '显示')} <span class="afx-num">${from}–${to}</span> ${afT('of', '/ 共')} <span class="afx-num">${AFX.total}</span></span>
      <span class="sp"></span>
      <button class="afx-pnav" data-afx="prev" ${AFX.page <= 1 ? 'disabled' : ''} aria-label="${afT('Previous page', '上一页')}">${AFX_I.chevl}</button>
      <button class="afx-pnav" data-afx="next" ${AFX.page >= pages ? 'disabled' : ''} aria-label="${afT('Next page', '下一页')}">${AFX_I.chevr}</button>
    </div>`;

  return `<div class="afx-tblcard${AFX.ledger === 'loading' ? ' afx-stale' : ''}"><div class="afx-tblwrap"><table class="afx-tbl">
      <thead><tr>
        <th>${afT('Referrer', '推荐人')}</th>
        <th>${afT('Friend', '好友')}</th>
        <th>${afT('Status', '状态')}</th>
        <th>${afT('Code', '邀请码')}</th>
        <th>${afT('Date', '日期')}</th>
        <th>${afT('First order', '首单')}</th>
        <th class="num">${afT('Earned', '已获奖励')}</th>
        <th class="act"></th>
      </tr></thead>
      <tbody>${AFX.rows.map(afxRow).join('')}</tbody>
    </table></div></div>${pagi}`;
}

function afxRenderLedger() {
  const host = $('#afx-ledger'); if (!host) return;
  // Typing in the search box is what triggers the reload that redraws this
  // whole region — so remember the caret and put it back, or the operator
  // loses focus mid-word every 250ms.
  const live = document.activeElement;
  const keepFocus = !!(live && live.hasAttribute && live.hasAttribute('data-afx-search'));
  const caret = keepFocus ? live.selectionStart : null;
  const s = AFX.summary || {};
  const disabled = AFX.ledger === 'error' || AFX.ledger === 'loading';
  const pills = afxFilters().map(f =>
    `<button class="${AFX.filter === f[0] ? 'on' : ''}" data-afx="filter:${f[0]}">${f[1]}${
      AFX.summary ? ` <span class="c">${f[2](s)}</span>` : ''}</button>`).join('');
  host.innerHTML = `<div class="afx-ledger">
      <div class="afx-ledger-h">${afT('Referrals', '推荐记录')}</div>
      <div class="afx-bar">
        <div class="afx-seg">${pills}</div>
        <span class="afx-bar-sp"></span>
        <label class="afx-search">${AFX_I.search}<input data-afx-search
          value="${escapeAttr(AFX.query)}"
          placeholder="${afT('Name, phone or code', '姓名、电话或邀请码')}"></label>
        <button class="afx-btn ghost" data-afx="refresh" ${disabled ? 'disabled' : ''}>${AFX_I.refresh}${afT('Refresh', '刷新')}</button>
      </div>
      ${afxLedgerBody()}
    </div>`;
  if (keepFocus) {
    const box = host.querySelector('[data-afx-search]');
    if (box) { box.focus(); try { box.setSelectionRange(caret, caret); } catch (e) { /* not a text input */ } }
  }
}

// ── row actions ─────────────────────────────────────────────────
async function afxVoid(id) {
  if (AFX.rowBusy) return;
  const c = AFX.rowConfirm;
  AFX.rowBusy = true; if (c) c.err = ''; afxRenderLedger();
  try {
    await api('/api/retail-admin/affiliate/referrals/' + id, {
      method: 'PATCH',
      body: { status: 'void', voided_reason: (c && c.reason ? c.reason : '').trim() || 'admin' },
    });
    AFX.rowBusy = false; AFX.rowConfirm = null;
    afxLoadReferrals();
  } catch (e) {
    AFX.rowBusy = false;
    if (AFX.rowConfirm) AFX.rowConfirm.err = afxWhy(e);
    afxRenderLedger();
  }
}
async function afxRestore(id) {
  if (AFX.rowBusy) return;
  AFX.rowBusy = true; if (AFX.rowConfirm) AFX.rowConfirm.err = ''; afxRenderLedger();
  try {
    await api('/api/retail-admin/affiliate/referrals/' + id, { method: 'PATCH', body: { status: 'joined' } });
    AFX.rowBusy = false; AFX.rowConfirm = null;
    afxLoadReferrals();
  } catch (e) {
    AFX.rowBusy = false;
    if (AFX.rowConfirm) AFX.rowConfirm.err = afxWhy(e);
    afxRenderLedger();
  }
}

// ── save bar ────────────────────────────────────────────────────
function afxSaveMessage() {
  const bits = [];
  if (afxChanged(['rewardPerOrder', 'rewardReferee'])) bits.push(afT('the offer', '奖励方案'));
  if (afxChanged(['lifetimeRatePercent', 'lifetimeMonths'])) bits.push(afT('the repeat-order share', '复购分成'));
  if (afxChanged(['lifetimeMode'])) bits.push(afT('who earns the repeat-order share', '复购分成的可获得范围'));
  if (afxChanged(['codePrefix'])) bits.push(afT('invite codes', '邀请码'));
  if (afxChanged(['shareImage'])) bits.push(afT('the share picture', '分享图片'));
  const joined = bits.length <= 1 ? (bits[0] || afT('these settings', '这些设置'))
    : bits.slice(0, -1).join(afT(', ', '、')) + afT(' and ', '和') + bits[bits.length - 1];
  return afT('You’ve changed ' + joined + '.', '您修改了' + joined + '。');
}

function afxRenderSaveBar() {
  const host = $('#afx-savebar'); if (!host) return;
  const dirty = afxDirty();
  if (!dirty && !AFX.saveSaid) { host.innerHTML = ''; return; }
  if (!dirty && AFX.saveSaid) {
    host.innerHTML = `<div class="afx-savebar"><div class="afx-savebar-in">
        <div class="afx-savebar-main"><div class="afx-savebar-msg">${afT('Saved.', '已保存。')}</div></div>
      </div></div>`;
    return;
  }
  const say = AFX.saveErr
    ? `<div class="afx-savebar-say bad">${escapeHtml(AFX.saveErr)}</div>`
    : afxChanged(AFX_MONEY_KEYS)
      ? `<div class="afx-savebar-say">${afT(
          'New amounts apply to referrals rewarded from now on — nothing already earned changes.',
          '新金额只对此后发放的奖励生效 — 已获得的奖励不受影响。')}</div>`
      : '';
  const btn = AFX.saving
    ? `<button class="afx-btn dusk" disabled><span class="afx-spin"></span>${afT('Saving…', '保存中…')}</button>`
    : `<button class="afx-btn dusk" data-afx="save">${afT('Save changes', '保存更改')}</button>`;
  host.innerHTML = `<div class="afx-savebar"><div class="afx-savebar-in">${say}
      <div class="afx-savebar-main">
        <div class="afx-savebar-msg"><b>${afxSaveMessage()}</b></div>
        <button class="afx-btn ghost" data-afx="discard" ${AFX.saving ? 'disabled' : ''}>${afT('Discard', '放弃更改')}</button>
        ${btn}
      </div></div></div>`;
}

// ── share picture upload ────────────────────────────────────────
async function afxUploadPicture(file) {
  if (!file || AFX.uploading) return;
  AFX.uploading = true; afxRenderSettings();
  try {
    const fd = new FormData(); fd.append('file', file);
    const res = await fetch('/api/retail-admin/media/upload', { method: 'POST', credentials: 'same-origin', body: fd });
    const j = await res.json();
    if (!j.success) throw new Error(j.error || 'upload_failed');
    AFX.cfg.shareImage = j.data.url;
    AFX.picErr = '';
  } catch (e) {
    AFX.picErr = afT('Upload failed. ', '上传失败。') + afxWhy(e);
  }
  AFX.uploading = false;
  afxRenderSettings(); afxRenderSaveBar();
}

// ── events ──────────────────────────────────────────────────────
document.addEventListener('click', e => {
  const t = e.target.closest ? e.target.closest('[data-afx]') : null;
  if (!t || !t.closest('#tab-affiliate')) return;
  const a = t.dataset.afx;
  e.preventDefault();

  if (a === 'program-on')  { afxSetProgram(true); return; }
  if (a === 'program-off') { afxSetProgram(false); return; }
  if (a === 'reload-settings') { afxLoadSettings(); return; }
  // The one Dusk action on the page: the invite has no home-screen block, and
  // the Mini App Editor is where one gets added.
  if (a === 'go-home-layout') { goTab('mini-app-editor'); return; }
  if (a === 'settings-toggle') {
    AFX.settingsOpen = !AFX.settingsOpen;
    const box = $('#afx-settings');
    if (box) box.hidden = !AFX.settingsOpen;
    afxRenderOffer();
    if (AFX.settingsOpen && box) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  // Arming the repeat-order share is a money decision, so it asks first;
  // turning it off is instant (Marketing precedent #8).
  if (a === 'life') {
    if (afxLifeOn(AFX.cfg)) { AFX.cfg.lifetimeRatePercent = 0; AFX.lifeArm = false; }
    else { AFX.lifeArm = true; }
    afxRenderSettings(); afxRenderOffer(); afxRenderSaveBar(); return;
  }
  if (a === 'life-confirm') {
    AFX.cfg.lifetimeRatePercent = Number(AFX.saved.lifetimeRatePercent) > 0
      ? Number(AFX.saved.lifetimeRatePercent) : AFX_LIFETIME_START_PCT;
    AFX.lifeArm = false;
    afxRenderSettings(); afxRenderOffer(); afxRenderSaveBar(); return;
  }
  if (a === 'life-cancel') { AFX.lifeArm = false; afxRenderSettings(); return; }

  // Switching mode is an ordinary edit — it goes through the save bar like the
  // rate and the months do, so an operator can change their mind before it
  // takes effect. Only the picked LIST writes immediately (see afxEligSet):
  // that is a roster, not a setting, and holding it behind the same save bar
  // would let a half-built list be discarded by a Discard aimed at the rate.
  if (a === 'mode:everyone' || a === 'mode:selected') {
    const want = a === 'mode:selected' ? 'selected' : 'everyone';
    if (AFX.cfg.lifetimeMode === want) return;
    AFX.cfg.lifetimeMode = want;
    if (want === 'selected' && AFX.eligCount === null) afxLoadEligCount();
    afxRenderSettings(); afxRenderOffer(); afxRenderSaveBar(); return;
  }
  if (a === 'manage-eligible') { afxOpenEligible(); return; }

  if (a === 'pic-replace') { $('#afx-share-file').click(); return; }
  if (a === 'pic-remove')  { AFX.cfg.shareImage = ''; afxRenderSettings(); afxRenderSaveBar(); return; }

  if (a === 'save')    { afxSave(); return; }
  if (a === 'discard') { afxDiscard(); return; }

  if (a.startsWith('filter:')) { AFX.filter = a.slice(7); AFX.page = 1; afxLoadReferrals(); return; }
  if (a === 'refresh') { afxLoadReferrals(); return; }
  if (a === 'prev') { if (AFX.page > 1) { AFX.page--; afxLoadReferrals(); } return; }
  if (a === 'next') { AFX.page++; afxLoadReferrals(); return; }

  if (a.startsWith('void:'))    { AFX.rowConfirm = { id: +a.slice(5), kind: 'void', reason: '' }; afxRenderLedger(); return; }
  if (a.startsWith('restore:')) { AFX.rowConfirm = { id: +a.slice(8), kind: 'restore' }; afxRenderLedger(); return; }
  if (a === 'row-cancel')       { AFX.rowConfirm = null; afxRenderLedger(); return; }
  if (a.startsWith('void-yes:'))    { afxVoid(+a.slice(9)); return; }
  if (a.startsWith('restore-yes:')) { afxRestore(+a.slice(12)); return; }

  // ONE way to open a customer. The old build called cuOpenDetail() for the
  // referrer and cuOpen() for the friend — and cuOpen() does not exist, so
  // every friend's name in the ledger threw a ReferenceError instead of
  // opening anything.
  if (a.startsWith('cust:')) { cuOpenDetail(+a.slice(5)); return; }
});

document.addEventListener('input', e => {
  const t = e.target;
  if (!t || !t.closest || !t.closest('#tab-affiliate')) return;

  if (t.hasAttribute('data-afx-search')) { AFX.query = t.value.trim(); afxSearchLater(); return; }
  if (t.hasAttribute('data-afx-reason')) { if (AFX.rowConfirm) AFX.rowConfirm.reason = t.value; return; }

  const key = t.getAttribute('data-afx-field');
  if (!key || !AFX.cfg) return;
  // Never re-render the settings column on a keystroke — the field would lose
  // focus mid-word. Only the two derived lines and the save bar redraw.
  AFX.cfg[key] = key === 'codePrefix' ? t.value.toUpperCase() : afxNum(t.value);
  const restate = $('#afx-restate'); if (restate) restate.innerHTML = afxRestate();
  const note = $('#afx-life-note');  if (note) note.innerHTML = afxLifeNote();
  afxRenderOffer();
  afxRenderSaveBar();
});

document.addEventListener('change', e => {
  if (e.target.id === 'afx-share-file' && e.target.files && e.target.files[0]) {
    afxUploadPicture(e.target.files[0]);
    e.target.value = '';
  }
});

// ── boot ────────────────────────────────────────────────────────
function afxRenderAll() {
  afxRenderHead(); afxRenderVerdict(); afxRenderPlacements();
  afxRenderOffer(); afxRenderSettings(); afxRenderLedger(); afxRenderSaveBar();
}
function afxBoot() {
  if (AFX.booted) return;
  AFX.booted = true;
  // No blank cfg to start from: rendering ¥0 for a beat before the real offer
  // arrives shows the operator a figure that was never their setting. The
  // column stays empty until it can tell the truth.
  afxRenderAll();
  afxLoadOverview();
  afxLoadSettings();
  afxLoadReferrals();
}
document.querySelector('[data-tab="affiliate"]').addEventListener('click', afxBoot);

// Every region is built with cuT and marked data-no-i18n, so the walker never
// sees it — redraw the whole page when the admin flips language.
if (window.onLangChange) {
  onLangChange(() => { if (AFX.booted) afxRenderAll(); });
}

// Self-contained Tacet status pill (inline styles, no scoped CSS needed) so it
// also renders correctly inside the customer drawer's affiliate block, which
// lives outside #tab-affiliate.
function afStatusPill(status) {
  const base = 'display:inline-flex;align-items:center;gap:4px;font-size:13px;font-weight:500;border-radius:999px;padding:2px 8px;white-space:nowrap;';
  const map = {
    ordered: { css: 'background:var(--td-sage-tint);color:var(--td-sage-ink);',  label: afT('Rewarded', '已奖励') },
    joined:  { css: 'background:var(--td-amber-tint);color:var(--td-amber-ink);', label: afT('Waiting', '待首单') },
    void:    { css: 'background:transparent;border:1px solid var(--line);color:var(--text-3);', label: afT('Voided', '已作废') },
  };
  const s = map[status] || map.void;
  return `<span style="${base}${s.css}">${s.label}</span>`;
}

// ════════════════════════════════════════════════════════════════
// SHARE CARDS — Tacet workspace (option B). A left page list; the
// selected page opens on the right with its title fields, picture and
// ONE big live WeChat-forward preview so the operator sees exactly what
// a friend receives. Storage is unchanged:
//   • Home / Product / Voting → config keys sharing.<key> (picture) and
//     sharing.<key>Title = {en,cn} (Product has no title). The customer
//     /api/retail/config endpoint absolutizes the pictures for WeChat.
//   • Invite → affiliate.shareImage + affiliate.shareTitle, the SAME keys
//     as Marketing → Affiliate, so the two surfaces stay in sync.
// Edits live in-memory (SC_DATA) as you switch pages; Save persists the
// selected page. Media upload reuses /api/retail-admin/media/upload.
// Markup: #tab-sharing + #tacet-sharecards-skin in retail-admin.html.
// ════════════════════════════════════════════════════════════════
const SC_KEYS = ['home', 'product', 'voting', 'invite'];
const SC_CFG = {
  home:    { titled: true,  ep: 'config' },
  product: { titled: false, ep: 'config' },
  voting:  { titled: true,  ep: 'config' },
  invite:  { titled: true,  ep: 'affiliate' },
};
// Per-page display copy — kept per language so the JS renders ONE language
// (the containers are data-no-i18n; the walker never sees them).
const SC_META = {
  home:    { name: { en: 'Home page',    cn: '首页' },   blurb: { en: 'Forwarding the store home, with no referral code.', cn: '转发店铺首页(不含推荐码)。' } },
  product: { name: { en: 'Product page', cn: '商品页' }, blurb: { en: 'Backup picture — used only when a product has no photo of its own.', cn: '备用图 — 仅当商品没有自己的图片时使用。' } },
  voting:  { name: { en: 'Voting page',  cn: '投票页' }, blurb: { en: 'Forwarding the community polls. A live poll titles itself.', cn: '转发社区投票页;有进行中的投票时用其问题作标题。' } },
  invite:  { name: { en: 'Invite card',  cn: '邀请卡片' }, blurb: { en: 'A customer sharing their referral code. In sync with Marketing → Affiliate.', cn: '顾客分享推荐码时显示;与“营销 → 分销”同步。' } },
};
// Muted placeholder shown in the preview when a card has no custom title —
// stands in for the app's built-in default. Tenant-neutral (no brand name).
const SC_EMPTY_TITLE = {
  home:    { en: 'Your store’s default title', cn: '店铺默认标题' },
  product: { en: 'The product’s own name',     cn: '商品自身名称' },
  voting:  { en: 'Vote with us',                    cn: '一起来投票' },
  invite:  { en: 'Invite reward + code (automatic)', cn: '邀请奖励 + 邀请码(自动)' },
};
const SC_ICON_USER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/></svg>';
const SC_ICON_MARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18M12 3v18"/></svg>';
let SHARING_LOADED = false;
let SC_SEL = 'home';
const SC_DATA = {};   // { key: { img: '', title: { en, cn } } }

// Current admin language (the i18n engine stores it under 'roots-admin-lang').
function scLang() { try { return localStorage.getItem('roots-admin-lang') === 'cn' ? 'cn' : 'en'; } catch (e) { return 'en'; } }
function scT(en, cn) { return scLang() === 'cn' ? cn : en; }
function scEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function scUrl(u) { return String(u || '').replace(/"/g, '%22'); }

// Build the WeChat forward preview (chat bubble + card) for the given key.
function scChatHTML(key) {
  const d = SC_DATA[key] || { img: '', title: {} };
  const lang = scLang();
  const custom = SC_CFG[key].titled ? String((d.title && d.title[lang]) || '').trim() : '';
  const titleText = custom || SC_EMPTY_TITLE[key][lang];
  const isDefault = !custom;
  const imgBlock = d.img
    ? '<div class="sc-wx-img" id="sc-pv-img"></div>'
    : '<div class="sc-wx-img sc-fb"><div class="sc-fb-lines"><i></i><i></i><i></i></div><div class="sc-fb-dot"></div></div>';
  return '<div class="sc-chat"><div class="sc-chatrow">'
    + '<div class="sc-avatar">' + SC_ICON_USER + '</div>'
    + '<div class="sc-wxcard">'
    +   '<div class="sc-wx-t' + (isDefault ? ' empty' : '') + '">' + scEsc(titleText) + '</div>'
    +   imgBlock
    +   '<div class="sc-wx-foot"><span class="sc-wx-lg">' + SC_ICON_MARK + '</span><span>' + scT('Mini Program', '小程序') + '</span></div>'
    + '</div></div></div>';
}

// Repaint only the stage preview (called on each keystroke — no form re-render,
// so the focused input keeps its cursor).
function scPaintPreview() {
  const box = $('#sc-pv'); if (!box) return;
  box.innerHTML = scChatHTML(SC_SEL);
  const d = SC_DATA[SC_SEL];
  if (d && d.img) { const el = $('#sc-pv-img'); if (el) el.style.backgroundImage = 'url("' + scUrl(d.img) + '")'; }
}

// One row in the left page list.
function scListRowHTML(key) {
  const d = SC_DATA[key] || { img: '' };
  const custom = !!d.img;
  const thumb = custom
    ? '<span class="sc-pthumb" data-thumb="' + key + '"></span>'
    : '<span class="sc-pthumb sc-fb"><span class="sc-fb-dot"></span></span>';
  const pill = custom
    ? '<span class="sc-pill custom"><span class="sc-dot"></span>' + scT('Set', '已设置') + '</span>'
    : '<span class="sc-pill deflt"><span class="sc-dot"></span>' + scT('Default', '默认') + '</span>';
  const name = scT(SC_META[key].name.en, SC_META[key].name.cn);
  const status = custom ? scT('Custom picture', '自定义图片') : scT('Page’s own look', '页面自带样式');
  return '<button type="button" class="sc-prow' + (key === SC_SEL ? ' sel' : '') + '" onclick="scSelect(\'' + key + '\')">'
    + thumb
    + '<span class="sc-pmeta"><span class="sc-pn">' + scEsc(name) + '</span><span class="sc-ps">' + status + '</span></span>'
    + '<span class="sc-pright">' + pill + '</span>'
    + '</button>';
}

function scRenderList() {
  const box = $('#sc-list'); if (!box) return;
  box.innerHTML = SC_KEYS.map(scListRowHTML).join('');
  SC_KEYS.forEach(k => {
    const d = SC_DATA[k];
    if (d && d.img) { const el = box.querySelector('[data-thumb="' + k + '"]'); if (el) el.style.backgroundImage = 'url("' + scUrl(d.img) + '")'; }
  });
}

// Render the right-hand editor + preview for the selected page.
function scRenderStage() {
  const box = $('#sc-stage'); if (!box) return;
  const key = SC_SEL;
  const cfg = SC_CFG[key];
  const d = SC_DATA[key] || { img: '', title: { en: '', cn: '' } };
  const en = (d.title && d.title.en) || '';
  const cn = (d.title && d.title.cn) || '';

  let fields;
  if (cfg.titled) {
    fields =
      '<div class="sc-fgroup"><label class="sc-flabel">' + scT('Card title', '卡片标题') + ' <span class="sc-lang">· English</span>'
      +   '<span class="sc-charc" id="sc-c-en">' + en.length + ' / 60</span></label>'
      + '<input type="text" class="sc-input" id="sc-t-en" maxlength="60" value="' + scEsc(en) + '" placeholder="' + scT('e.g. Fresh this week', '例如:本周上新') + '" oninput="scOnTitle(\'en\', this.value)"></div>'
      + '<div class="sc-fgroup"><label class="sc-flabel">卡片标题 <span class="sc-lang">· 中文</span>'
      +   '<span class="sc-charc" id="sc-c-cn">' + cn.length + ' / 60</span></label>'
      + '<input type="text" class="sc-input" id="sc-t-cn" maxlength="60" value="' + scEsc(cn) + '" placeholder="例如:本周上新" oninput="scOnTitle(\'cn\', this.value)"></div>';
  } else {
    fields = '<div class="sc-note">' + scT('Products share their own name and photo. This picture only fills in when a product has none.', '商品使用自己的名称和图片,此图仅在商品没有图片时兜底。') + '</div>';
  }
  const inviteNote = key === 'invite'
    ? '<div class="sc-note">' + scT('Leave the titles empty to keep the automatic one (with the reward and code).', '标题留空则使用自动文案(含奖励金额与邀请码)。') + '</div>'
    : '';
  const drop =
    '<div class="sc-fgroup"><label class="sc-flabel">' + scT('Picture', '图片') + ' <span class="sc-lang">· ' + scT('about 500 × 400', '约 500 × 400') + '</span></label>'
    + '<div class="sc-drop" onclick="document.getElementById(\'sc-file\').click()">'
    +   '<span class="sc-drop-thumb' + (d.img ? '' : ' sc-fb') + '" id="sc-drop-thumb">' + (d.img ? '' : '<span class="sc-fb-dot"></span>') + '</span>'
    +   '<span><span class="sc-drop-t">' + (d.img ? scT('Replace the picture', '更换图片') : scT('Drop a picture, or click to choose', '拖入图片,或点击选择')) + '</span>'
    +     '<span class="sc-drop-s">' + scT('PNG or JPG · shown at 5:4', 'PNG 或 JPG · 按 5:4 显示') + '</span></span>'
    + '</div>'
    + '<input type="file" id="sc-file" accept="image/png,image/jpeg" style="display:none">'
    + '<div class="sc-drophint">' + scT('Leave empty to use the page’s own look.', '留空则使用该页面自带样式。') + '</div></div>';
  const removeBtn = d.img ? '<button class="sc-btn danger" onclick="scClear()">' + scT('Remove picture', '移除图片') + '</button>' : '';

  box.innerHTML =
    '<div class="sc-sgrid">'
    + '<div class="sc-form">'
    +   '<div class="sc-stitle">' + scEsc(scT(SC_META[key].name.en, SC_META[key].name.cn)) + '</div>'
    +   '<div class="sc-ssub">' + scEsc(scT(SC_META[key].blurb.en, SC_META[key].blurb.cn)) + '</div>'
    +   fields + inviteNote + drop
    +   '<div class="sc-savebar"><button class="sc-save" onclick="scSave()">' + scT('Save card', '保存卡片') + '</button>'
    +     removeBtn
    +     '<span class="sc-saved" id="sc-saved"></span></div>'
    + '</div>'
    + '<div class="sc-spreview"><div class="sc-pv-capt">' + scT('Live preview', '实时预览') + '</div>'
    +   '<div id="sc-pv"></div>'
    +   '<div class="sc-pv-note">' + scT('Exactly what lands in the chat — picture, title, and the app row underneath.', '这就是聊天里显示的效果 — 图片、标题,以及下方的小程序信息。') + '</div>'
    + '</div>'
    + '</div>';

  scPaintPreview();
  if (d.img) { const el = $('#sc-drop-thumb'); if (el) el.style.backgroundImage = 'url("' + scUrl(d.img) + '")'; }
}

function scSelect(key) {
  if (!SC_KEYS.includes(key)) return;
  SC_SEL = key;
  scRenderList();
  scRenderStage();
}

// Title typed — update in-memory data, the char counter and the live preview.
// Deliberately does NOT re-render the form (that would drop input focus).
function scOnTitle(lang, val) {
  const d = SC_DATA[SC_SEL]; if (!d) return;
  if (!d.title) d.title = { en: '', cn: '' };
  d.title[lang] = val;
  const c = $('#sc-c-' + lang); if (c) c.textContent = val.length + ' / 60';
  scPaintPreview();
}

async function scUpload(file) {
  if (!file) return;
  const fd = new FormData(); fd.append('file', file);
  toast('Uploading… · 上传中…');
  try {
    const r = await fetch('/api/retail-admin/media/upload', { method: 'POST', credentials: 'same-origin', body: fd });
    const j = await r.json();
    if (!j.success) { toast('Upload failed · 上传失败: ' + (j.error || ''), 'err'); return; }
    SC_DATA[SC_SEL].img = j.data.url;
    scRenderList(); scRenderStage();
    toast('Uploaded — Save to apply · 已上传 — 保存后生效');
  } catch (e) { toast('Upload failed · 上传失败: ' + e.message, 'err'); }
}

function scClear() {
  if (SC_DATA[SC_SEL]) SC_DATA[SC_SEL].img = '';
  scRenderList(); scRenderStage();
  toast(scT('Picture removed — Save to apply', '已移除图片 — 保存后生效'));
}

function scSeed(key, img, title) {
  SC_DATA[key] = {
    img: String(img || ''),
    title: { en: (title && title.en) || '', cn: (title && title.cn) || '' },
  };
}

async function scLoad() {
  // Seed empty + paint immediately so the workspace shows even if a fetch
  // fails; then hydrate the two sources INDEPENDENTLY.
  SC_KEYS.forEach(k => scSeed(k, '', null));
  scRenderList(); scRenderStage();
  try {
    const cfgR = await api('/api/retail-admin/config');
    const sharing = (cfgR.data && cfgR.data.sharing) || {};
    scSeed('home',    sharing.home,    sharing.homeTitle);
    scSeed('product', sharing.product, null);
    scSeed('voting',  sharing.voting,  sharing.votingTitle);
  } catch (e) { toast('Couldn’t load page cards · 页面卡片加载失败: ' + e.message, 'err'); }
  try {
    const afR = await api('/api/retail-admin/affiliate/settings');
    const af = afR.data || {};
    scSeed('invite', af.shareImage, af.shareTitle);
  } catch (e) { toast('Couldn’t load invite card · 邀请卡片加载失败: ' + e.message, 'err'); }
  scRenderList(); scRenderStage();
}

async function scSave() {
  const key = SC_SEL;
  const d = SC_DATA[key];
  const img = String(d.img || '').trim();
  const titleObj = SC_CFG[key].titled
    ? { en: String(d.title.en || '').trim(), cn: String(d.title.cn || '').trim() }
    : { en: '', cn: '' };
  const saved = $('#sc-saved');
  try {
    if (SC_CFG[key].ep === 'affiliate') {
      await api('/api/retail-admin/affiliate/settings', { method: 'PATCH', body: { shareImage: img, shareTitle: titleObj } });
    } else {
      const body = {}; body['sharing.' + key] = img;
      if (SC_CFG[key].titled) body['sharing.' + key + 'Title'] = titleObj;
      await api('/api/retail-admin/config', { method: 'PUT', body });
    }
    toast('Card saved · 卡片已保存');
    if (saved) saved.textContent = scT('Saved just now', '刚刚已保存');
  } catch (e) { toast('Save failed · 保存失败: ' + e.message, 'err'); }
}

document.addEventListener('change', e => {
  if (e.target.id === 'sc-file' && e.target.files && e.target.files[0]) {
    scUpload(e.target.files[0]);
    e.target.value = '';
  }
});

document.querySelector('[data-tab="sharing"]').addEventListener('click', () => {
  if (!SHARING_LOADED) { SHARING_LOADED = true; scLoad(); }
});

// Re-render on language toggle so names, statuses, labels + preview follow it.
if (window.onLangChange) {
  onLangChange(() => { if (SHARING_LOADED) { scRenderList(); scRenderStage(); } });
}

// ── Theme toggle (light / dark) ──
// The pre-render script in <head> already set data-theme so paint is
// correct. This handler just paints the icon to match and lets the user
// flip it from the topbar; choice is persisted to localStorage so it
// survives reloads.
function cuApplyThemeIcon() {
  const t = document.documentElement.getAttribute('data-theme');
  const showSun  = $('#theme-icon-light');
  const showMoon = $('#theme-icon-dark');
  // Show the icon for the OTHER mode (the one you'd switch to).
  if (showSun)  showSun.style.display  = t === 'dark'  ? '' : 'none';
  if (showMoon) showMoon.style.display = t === 'light' ? '' : 'none';
  const meta = $('#meta-theme-color');
  if (meta) meta.setAttribute('content', t === 'light' ? '#E8E5DC' : '#12161A');
}
function cuSetTheme(t) {
  const next = t === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('retail-admin-theme', next); } catch (e) {}
  cuApplyThemeIcon();
  // Push the flip to the embedded Profile iframe (if open + loaded) so it
  // repaints without a reload. The frame only repaints — the parent owns the
  // localStorage write above (no write-back in the frame = no loop).
  if (window.profFramePost) window.profFramePost({ type: 'fc-theme', theme: next });
}
function cuToggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  cuSetTheme(current === 'dark' ? 'light' : 'dark');
}
cuApplyThemeIcon();

// ── i18n / Language toggle ──
// NOTE: the AUTHORITATIVE copy of this engine now runs INLINE in retail-admin.html,
// right before the module <script> tags, so the bilingual "EN · 中文" markup is
// collapsed to one language DURING HTML parse — before first paint, with zero
// network wait. That is what stops the flash-of-both-languages on a cold refresh
// (the old failsafe used to reveal the raw bilingual page after 3s when this
// 10th-of-17 script hadn't downloaded yet). This copy is kept as a self-guarded
// FALLBACK: if the inline engine ever runs, it sets window.__raI18nEngine and this
// block no-ops; if the inline copy is removed/errors, this one still initializes.
(function () {
  if (window.__raI18nEngine) return;
  window.__raI18nEngine = 1;
  // Shared across the whole admin suite (app.html / cms.html / product-editor.html)
  // so the language you pick on one surface follows you into the others.
  const LANG_KEY = 'roots-admin-lang';
  let _lang = 'en';
  const _listeners = [];
  try { const s = localStorage.getItem(LANG_KEY); if (s === 'en' || s === 'cn') _lang = s; } catch {}

  const EN_ONLY_MAP = {
    'Mini App Editor': '小程序编辑器',
    'Dashboard': '主控台',
    'All': '全部',
    'Pending': '待付款',
    'Paid': '已付款',
    'Preparing': '备货中',
    'Rider coming': '骑手前往取货',
    'Dispatched': '已发货',
    'Delivered': '已送达',
    'Awaiting restock': '等待补货',
    'Cancelled': '已取消',
    'Refunded': '已退款',
    'Refund queue': '退款队列',
    'Refresh': '刷新',
    'Bulk attach tracking': '批量绑定运单号',
    'Include blocked': '包括已封禁',
    '‹ Prev': '‹ 上一页',
    'Active & scheduled': '进行中 & 已排期',
    'Save flash sale': '保存秒杀',
    'Update flash sale': '更新秒杀',
    'New flash sale': '新建秒杀',
    'No flash sales yet': '暂无秒杀活动',
    'ACTIVE': '进行中',
    'UPCOMING': '即将开始',
    'ENDED': '已结束',
    'JOINED': '已加入',
    'ORDERED': '已下单',
    'VOIDED': '已作废',
    'Loading preview…': '加载预览中…',
    'Live': '开启',
    'Off': '关闭',
    'Bilingual': '双语',
    'English only': '仅英文',
    '中文 only': '仅中文',
    'Loading…': '加载中…',
    'Adding…': '添加中…',
    'Added ✓': '已添加 ✓',
    'Deleting…': '删除中…',
    'Deleted ✓': '已删除 ✓',
    'Saving…': '保存中…',
    'Saved': '已保存',
    'Saved ✓': '已保存 ✓',
    'Sending…': '发送中…',
    'Saving order…': '保存排序中…',
    'Order saved ✓': '排序已保存 ✓',
  };

  // Only treat "X · Y" as a bilingual label when the right side contains
  // Chinese characters. Prevents splitting data strings like
  // "asher · 18613159912" or "subtotal ¥118 · shipping ¥30".
  function hasChinese(s) { return /[一-鿿]/.test(s); }

  // Registry of every text node we translate: { node, en, cn }. We toggle
  // language by rewriting node.nodeValue in place — NO elements are ever
  // created, removed, or restructured, so flex/grid layouts and charts are
  // physically untouched. Disconnected nodes are pruned on toggle.
  const _reg = [];
  // Same idea for tooltips: their text lives in an attribute, not a text node,
  // so it needs its own registry. data-tt (the shared tooltip component in
  // 01-core.js) is the only one left — it is authored "EN · CN" like every
  // other label. The list stays a list so a second attribute is a one-word
  // change. { el, attr, en, cn }.
  const _tipReg = [];
  const TIP_ATTRS = ['data-tt'];
  // Opt-in bilingual placeholders: tag an input/textarea with data-ph-en +
  // data-ph-cn and we swap its `placeholder` on toggle. Opt-in (not auto-split
  // like text) because many placeholders carry a decorative " · " that is NOT a
  // translation divider (e.g. "Mon–Sat · 9am–6pm", "ROOTS CLUB · LEADERBOARD").
  const _phReg = [];
  // Native HTML title="" hover tooltips. Same "EN · CN" model as data-tip,
  // but the text-node/data-tip walkers never see title attributes — so without
  // this, bilingual title labels stay frozen and always show the Chinese half
  // on hover regardless of the active language. { el, en, cn }.
  const _titleReg = [];

  // Never touch text inside these — code, user input, or vector graphics
  // (chart labels). Translating them would corrupt rendering.
  function inSkippedContext(el) {
    for (let n = el; n; n = n.parentElement) {
      if (!n.tagName) break;
      const T = n.tagName.toUpperCase();
      if (T === 'SCRIPT' || T === 'STYLE' || T === 'TEXTAREA' || T === 'INPUT' ||
          T === 'NOSCRIPT' || T === 'SVG' || T === 'CANVAS') return true;
      if (n.namespaceURI === 'http://www.w3.org/2000/svg') return true;
      if (n.dataset && n.dataset.noI18n != null) return true;
    }
    return false;
  }

  function processNode(textNode) {
    if (textNode.__i18nDone) return;
    const parent = textNode.parentElement;
    if (!parent || inSkippedContext(parent)) return;

    const text = textNode.nodeValue || '';
    let en, cn, lead = '', trail = '';
    const idx = text.indexOf(' · ');
    if (idx !== -1) {
      const left = text.slice(0, idx);
      const right = text.slice(idx + 3);
      en = left.trim();
      cn = right.trim();
      if (!en || !cn) return;
      if (!hasChinese(cn) || hasChinese(en)) return;
      // Preserve any surrounding whitespace so inline spacing is unchanged.
      lead  = left.slice(0, left.length - left.trimStart().length);
      trail = right.slice(right.trimEnd().length);
    } else {
      const trimmed = text.trim();
      if (!EN_ONLY_MAP[trimmed]) return;
      en = trimmed;
      cn = EN_ONLY_MAP[trimmed];
      lead  = text.slice(0, text.length - text.trimStart().length);
      trail = text.slice(text.trimEnd().length);
    }

    const enFull = lead + en + trail;
    const cnFull = lead + cn + trail;
    textNode.__i18nDone = true;
    textNode.nodeValue = _lang === 'cn' ? cnFull : enFull;
    _reg.push({ node: textNode, en: enFull, cn: cnFull });
  }

  // Block-pair detection: a help paragraph is often written as two stacked
  // siblings — an all-English <div>/<p> next to an all-Chinese one. We tag the
  // pair (data-lang-block="en"/"cn") and a CSS rule hides the inactive side.
  // Restricting to div/p + same-tag + adjacency keeps this away from data
  // tables, where a CN cell next to an EN cell is NOT a translation pair.
  function isCNBlock(el) {
    const t = el.textContent || '';
    return /[一-鿿]/.test(t) && !/[A-Za-z]/.test(t);
  }
  function isENBlock(el) {
    const t = el.textContent || '';
    return /[A-Za-z]/.test(t) && !/[一-鿿]/.test(t);
  }
  // Block pairs are prose help text. Interactive chrome (the nav tab bar, the
  // topbar) is not a translation pair — but in CN mode its labels are all
  // Chinese, so isCNBlock() would match it and pair it with an EN sibling,
  // stamping data-lang-block on a structural container. The CSS then hides the
  // whole bar in the opposite language. Guard: never tag a container that holds
  // interactive/structural children.
  function isStructuralBlock(el) {
    return !!el.querySelector('button, a, input, select, textarea, svg');
  }
  function tagBlockPair(cnEl) {
    if (cnEl.dataset.langBlock || (cnEl.textContent || '').trim().length < 6) return;
    if (inSkippedContext(cnEl) || isStructuralBlock(cnEl)) return;
    const prev = cnEl.previousElementSibling, next = cnEl.nextElementSibling;
    let enEl = null;
    if (prev && prev.tagName === cnEl.tagName && !prev.dataset.langBlock && isENBlock(prev) && !inSkippedContext(prev) && !isStructuralBlock(prev)) enEl = prev;
    else if (next && next.tagName === cnEl.tagName && !next.dataset.langBlock && isENBlock(next) && !inSkippedContext(next) && !isStructuralBlock(next)) enEl = next;
    if (!enEl) return;
    cnEl.dataset.langBlock = 'cn';
    enEl.dataset.langBlock = 'en';
  }
  function processBlocks(root) {
    const scope = (root && root.nodeType === 1) ? root : document.body;
    if (scope.tagName === 'DIV' || scope.tagName === 'P') {
      if (isCNBlock(scope)) tagBlockPair(scope);
    }
    scope.querySelectorAll && scope.querySelectorAll('div, p').forEach(el => {
      if (isCNBlock(el)) tagBlockPair(el);
    });
  }

  // Tooltips store their text in an "EN · CN" attribute, which the text-node
  // walker never sees. Split it once, register both halves, and show the
  // active language — the same model used for text nodes.
  function processTipAttr(el, attr) {
    if (el.__i18nTipDone && el.__i18nTipDone[attr]) return;
    const raw = el.getAttribute(attr) || '';
    const idx = raw.indexOf(' · ');
    if (idx === -1) return;
    const en = raw.slice(0, idx).trim();
    const cn = raw.slice(idx + 3).trim();
    if (!en || !cn) return;
    // Unlike text nodes, a tooltip's English half may legitimately contain
    // Chinese (e.g. district names like 天河区 used as examples), so we only
    // require the CN half to be Chinese — the first ' · ' is the divider.
    if (!hasChinese(cn)) return;
    (el.__i18nTipDone = el.__i18nTipDone || {})[attr] = true;
    el.setAttribute(attr, _lang === 'cn' ? cn : en);
    _tipReg.push({ el, attr, en, cn });
  }
  function processTip(el) {
    for (const a of TIP_ATTRS) if (el.hasAttribute(a)) processTipAttr(el, a);
  }
  function processTips(root) {
    const scope = (root && root.nodeType === 1) ? root : document.body;
    const sel = TIP_ATTRS.map(a => '[' + a + ']').join(',');
    if (scope.matches && scope.matches(sel)) processTip(scope);
    scope.querySelectorAll && scope.querySelectorAll(sel).forEach(processTip);
  }

  // Opt-in bilingual placeholders — see _phReg note above.
  function processPh(el) {
    if (el.__i18nPhDone) return;
    const en = el.getAttribute('data-ph-en'), cn = el.getAttribute('data-ph-cn');
    if (en == null || cn == null) return;
    el.__i18nPhDone = true;
    el.setAttribute('placeholder', _lang === 'cn' ? cn : en);
    _phReg.push({ el, en, cn });
  }
  function processPhs(root) {
    const scope = (root && root.nodeType === 1) ? root : document.body;
    if (scope.hasAttribute && scope.hasAttribute('data-ph-en')) processPh(scope);
    scope.querySelectorAll && scope.querySelectorAll('[data-ph-en]').forEach(processPh);
  }

  // Native title="" tooltips — same split-once model as data-tip. Only treat
  // it as bilingual when the half after the first " · " contains Chinese, so
  // data-bearing titles ("asher · 18613159912", "5 orders · ¥320") and
  // single-language titles are left untouched.
  function processTitle(el) {
    if (el.__i18nTitleDone) return;
    const raw = el.getAttribute('title') || '';
    const idx = raw.indexOf(' · ');
    if (idx === -1) return;
    const en = raw.slice(0, idx).trim();
    const cn = raw.slice(idx + 3).trim();
    if (!en || !cn || !hasChinese(cn)) return;
    el.__i18nTitleDone = true;
    el.setAttribute('title', _lang === 'cn' ? cn : en);
    _titleReg.push({ el, en, cn });
  }
  function processTitles(root) {
    const scope = (root && root.nodeType === 1) ? root : document.body;
    if (scope.hasAttribute && scope.hasAttribute('title')) processTitle(scope);
    scope.querySelectorAll && scope.querySelectorAll('[title]').forEach(processTitle);
  }

  function processSubtree(root) {
    if (!root) return;
    if (root.nodeType === 3) { processNode(root); return; }
    if (root.nodeType !== 1 || inSkippedContext(root)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) {
      if (n.__i18nDone) continue;
      const t = n.nodeValue;
      if (t && (t.indexOf(' · ') !== -1 || EN_ONLY_MAP[t.trim()])) nodes.push(n);
    }
    nodes.forEach(processNode);
    processBlocks(root);
    processTips(root);
    processPhs(root);
    processTitles(root);
  }

  function applyLang(lang) {
    _lang = lang;
    document.documentElement.dataset.uiLang = lang;
    for (let i = _reg.length - 1; i >= 0; i--) {
      const e = _reg[i];
      if (!e.node.isConnected) { _reg.splice(i, 1); continue; }
      e.node.nodeValue = lang === 'cn' ? e.cn : e.en;
    }
    for (let i = _tipReg.length - 1; i >= 0; i--) {
      const e = _tipReg[i];
      if (!e.el.isConnected) { _tipReg.splice(i, 1); continue; }
      e.el.setAttribute(e.attr, lang === 'cn' ? e.cn : e.en);
    }
    for (let i = _phReg.length - 1; i >= 0; i--) {
      const e = _phReg[i];
      if (!e.el.isConnected) { _phReg.splice(i, 1); continue; }
      e.el.setAttribute('placeholder', lang === 'cn' ? e.cn : e.en);
    }
    for (let i = _titleReg.length - 1; i >= 0; i--) {
      const e = _titleReg[i];
      if (!e.el.isConnected) { _titleReg.splice(i, 1); continue; }
      e.el.setAttribute('title', lang === 'cn' ? e.cn : e.en);
    }
    processSubtree(document.body);  // pick up anything not yet registered
    try { localStorage.setItem(LANG_KEY, lang); } catch {}
    updateBtn();
    _listeners.forEach(cb => { try { cb(lang); } catch {} });
  }

  function updateBtn() {
    const btn = document.getElementById('lang-toggle');
    if (btn) btn.textContent = _lang === 'cn' ? 'EN' : '中文';
  }

  // Auto-translate content added by JS after load (order drawers, table rows,
  // etc.). Rewriting nodeValue does NOT fire childList mutations, so there is
  // no feedback loop and no need to disconnect.
  const _mo = new MutationObserver(function (mutations) {
    const batch = [];
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1 || node.nodeType === 3) batch.push(node);
      }
    }
    if (!batch.length) return;
    // Process synchronously here (the observer callback is a microtask that
    // runs BEFORE the browser paints) rather than on a deferred timer. The
    // old 60ms setTimeout let freshly-inserted "EN · CN" nodes paint raw for
    // a frame, which showed as a flash of Chinese whenever the dashboard
    // re-rendered — e.g. on tab re-focus / window minimize-restore.
    batch.forEach(function (nd) { try { processSubtree(nd); } catch (e) {} });
  });

  window.cuToggleLang  = function () { applyLang(_lang === 'cn' ? 'en' : 'cn'); };
  window.cuT           = function (en, cn) { return _lang === 'cn' ? cn : en; };
  window.cuLang        = function () { return _lang; };
  window.onLangChange  = function (cb) { _listeners.push(cb); };

  function init() {
    document.documentElement.dataset.uiLang = _lang;
    const st = document.createElement('style');
    st.textContent = 'html[data-ui-lang="en"] [data-lang-block="cn"]{display:none!important}'
                   + 'html[data-ui-lang="cn"] [data-lang-block="en"]{display:none!important}';
    document.head.appendChild(st);
    try { processSubtree(document.body); } catch (e) {}
    updateBtn();
    _mo.observe(document.body, { childList: true, subtree: true });
  }

  // Collapse the bilingual chrome as soon as THIS module executes rather than
  // waiting for DOMContentLoaded. This script sits at the end of <body>, so all
  // static markup above it is already parsed and present — we can stamp
  // data-ui-lang, hide the second language, and reveal the page right now.
  // Waiting for DOMContentLoaded meant waiting for the remaining parser-blocking
  // modules (11-17) to download and run; on a slow/cold load that could exceed
  // the 3s anti-FOUC failsafe, which then revealed the page in its raw EN · CN
  // state — the flash of both languages before it settles to one. The
  // MutationObserver started inside init() still catches anything the later
  // modules inject.
  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();


// ── Leaderboard ──
// Build/edit lives entirely here in the admin; the mini app renders
// read-only off the saved config. Lazy-load on first tab open.
let LB_LOADED = false;
let LB_PREVIEW_DATA = null;
const LB_FIELDS = [
  'enabled','title_en','title_cn','kicker_en','kicker_cn','subhead_en','subhead_cn',
  'metric','period','top_n','reveal_mode',
  'reward_top1_en','reward_top1_cn','reward_top3_en','reward_top3_cn','reward_top10_en','reward_top10_cn',
];
const LB_FIELD_TO_ID = {
  enabled: 'lb-enabled',
  title_en: 'lb-title-en', title_cn: 'lb-title-cn',
  kicker_en: 'lb-kicker-en', kicker_cn: 'lb-kicker-cn',
  subhead_en: 'lb-subhead-en', subhead_cn: 'lb-subhead-cn',
  metric: 'lb-metric', period: 'lb-period',
  top_n: 'lb-top-n', reveal_mode: 'lb-reveal',
  reward_top1_en: 'lb-r1-en', reward_top1_cn: 'lb-r1-cn',
  reward_top3_en: 'lb-r3-en', reward_top3_cn: 'lb-r3-cn',
  reward_top10_en: 'lb-r10-en', reward_top10_cn: 'lb-r10-cn',
};

// Placeholder ("seed") board — a temporary fake leaderboard to prime a new
// store before real activity exists. Held here as an array of {name, value,
// tier_key}; saved alongside the rest of the config and blended server-side.
let LB_SEED_ENTRIES = [];
// Realistic-looking nicknames, split into Western and Chinese pools so the
// generator can hold a fixed ratio (default 70% Western / 30% Chinese).
// Default reveal masks these to the first character, so the exact text mainly
// matters in "full" reveal mode.
const LB_SEED_NAMES_WEST = [
  'Emma', 'Oliver', 'Sophie', 'Liam', 'Chloe', 'Lucas', 'Grace', 'Ethan',
  'Ava', 'Noah', 'Isla', 'Max', 'Ruby', 'Leo', 'Hazel', 'Theo', 'Nina',
  'Ivy', 'Felix', 'Daisy', 'Owen', 'Lily', 'Jasper', 'Elena', 'Marcus',
  'Clara', 'Hugo', 'Stella', 'Adrian', 'Naomi', 'Victor', 'Freya',
];
const LB_SEED_NAMES_CN = [
  '小确幸', '清晨慢跑', '一颗西兰花', '半糖主义', '林深时见鹿', '番茄炒蛋',
  '海盐柠檬', '江南细雨', '木棉花', '一勺蜂蜜', '南山以南', '慢慢来呀',
  '小满', '晚风温柔', '橙子味的猫', '麦田守望者',
];
const LB_SEED_WEST_RATIO = 0.7;   // 70% Western, 30% Chinese
// Tier badges aren't shown on the leaderboard page, but keep them plausible
// for any surface that does read tier_key (top earners trend higher).
function lbSeedTier(frac) {
  if (frac < 0.10) return 'tree';
  if (frac < 0.35) return 'root';
  if (frac < 0.70) return 'sprout';
  return 'seed';
}
function lbShuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function lbUpdateSeedSummary() {
  const el = $('#lb-seed-summary');
  if (!el) return;
  if (!LB_SEED_ENTRIES.length) { el.textContent = cuT('No placeholder members yet.', '尚未生成占位会员。'); return; }
  const top = LB_SEED_ENTRIES[0], bottom = LB_SEED_ENTRIES[LB_SEED_ENTRIES.length - 1];
  el.textContent = cuT(
    LB_SEED_ENTRIES.length + ' members · ' + acWrap(top.value) + ' → ' + acWrap(bottom.value),
    LB_SEED_ENTRIES.length + ' 位会员 · ' + acWrap(top.value) + ' → ' + acWrap(bottom.value)
  );
}
// Build a believable descending spend distribution from the top value down,
// with light jitter, then force it strictly decreasing.
function lbGenerateSeed() {
  const max = Math.max(50, parseInt($('#lb-seed-max') && $('#lb-seed-max').value, 10) || 3000);
  const count = Math.max(3, Math.min(50, parseInt($('#lb-seed-count') && $('#lb-seed-count').value, 10) || 18));
  // Hold the Western/Chinese ratio, then shuffle so the two aren't grouped by
  // rank. Fall back to "Member N" only if a pool runs out at very high counts.
  const westN = Math.round(count * LB_SEED_WEST_RATIO);
  const names = lbShuffle(
    lbShuffle(LB_SEED_NAMES_WEST).slice(0, westN)
      .concat(lbShuffle(LB_SEED_NAMES_CN).slice(0, count - westN))
  );
  const entries = [];
  for (let i = 0; i < count; i++) {
    const frac = count > 1 ? i / (count - 1) : 0;           // 0 (top) .. 1 (bottom)
    let v = max * Math.pow(1 - frac, 1.35);                 // steeper near the top
    v = v * (1 + (Math.random() - 0.5) * 0.08);             // ±4% jitter
    v = Math.max(max * 0.04, v);
    entries.push({ name: names[i] || ('Member ' + (i + 1)), value: Math.round(v / 5) * 5, tier_key: lbSeedTier(frac) });
  }
  entries[0].value = max;                                    // exact requested top
  for (let i = 1; i < entries.length; i++) {                // enforce strict descent
    if (entries[i].value >= entries[i - 1].value) entries[i].value = Math.max(20, entries[i - 1].value - 5);
  }
  LB_SEED_ENTRIES = entries;
  const box = $('#lb-seed-enabled');
  if (box) box.checked = true;                              // generating implies "use it"
  lbUpdateSeedSummary();
  lbRenderPreview();
  toast(cuT('Placeholder members generated', '已生成占位会员'));
}

async function lbLoad() {
  try {
    const r = await fetch('/api/retail-admin/leaderboard/config', { credentials: 'same-origin' });
    const body = await r.json();
    if (!body.success) throw new Error(body.error || 'load_failed');
    lbApplyConfigToForm(body.data);
  } catch (e) {
    console.warn('[lb] config load failed', e);
    toast('Failed to load leaderboard config · 加载排行榜配置失败: ' + e.message);
  }
  await lbLoadPreview();
  lbRenderPreview();
}
function lbApplyConfigToForm(cfg) {
  for (const f of LB_FIELDS) {
    const id = LB_FIELD_TO_ID[f];
    const el = document.getElementById(id);
    if (!el) continue;
    if (f === 'enabled') el.checked = !!cfg[f];
    else el.value = cfg[f] != null ? cfg[f] : '';
  }
  const seedBox = $('#lb-seed-enabled');
  if (seedBox) seedBox.checked = !!cfg.seed_enabled;
  LB_SEED_ENTRIES = Array.isArray(cfg.seed_entries) ? cfg.seed_entries : [];
  const hideEl = $('#lb-hide-names');
  if (hideEl) hideEl.value = Array.isArray(cfg.hide_names) ? cfg.hide_names.join(', ') : '';
  lbUpdateSeedSummary();
  lbUpdateEnabledPill();
}
function lbReadForm() {
  const out = {};
  for (const f of LB_FIELDS) {
    const id = LB_FIELD_TO_ID[f];
    const el = document.getElementById(id);
    if (!el) continue;
    if (f === 'enabled') out[f] = !!el.checked;
    else if (f === 'top_n') out[f] = parseInt(el.value, 10) || 20;
    else out[f] = el.value;
  }
  const seedBox = $('#lb-seed-enabled');
  out.seed_enabled = !!(seedBox && seedBox.checked);
  out.seed_entries = LB_SEED_ENTRIES;
  const hideEl = $('#lb-hide-names');
  out.hide_names = hideEl ? hideEl.value.split(/[,\n]/).map(s => s.trim()).filter(Boolean) : [];
  return out;
}
function lbUpdateEnabledPill() {
  const on = $('#lb-enabled') && $('#lb-enabled').checked;
  const pill = $('#lb-current-pill');
  if (!pill) return;
  pill.classList.toggle('on', on);
  pill.classList.toggle('off', !on);
  pill.textContent = cuT(on ? 'Live' : 'Off', on ? '开启' : '关闭');
  // Mirror the state onto the nav row's OFF pill — but only once the real
  // config has loaded, so the default-unchecked checkbox doesn't flag it off.
  if (LB_LOADED) document.body.classList.toggle('lb-off', !on);
}
// Seed the nav OFF pill at startup. The full leaderboard config (form + preview)
// lazy-loads on first tab open; this is just the lightweight enabled flag so the
// nav reflects reality before the operator ever visits the tab.
async function lbInitNavState() {
  try {
    const r = await fetch('/api/retail-admin/leaderboard/config', { credentials: 'same-origin' });
    const b = await r.json();
    if (b && b.success && b.data) document.body.classList.toggle('lb-off', !b.data.enabled);
  } catch (e) { /* leave nav as-is if the probe fails */ }
}
async function lbLoadPreview() {
  try {
    const r = await fetch('/api/retail-admin/leaderboard/preview', { credentials: 'same-origin' });
    const body = await r.json();
    if (!body.success) throw new Error(body.error || 'preview_failed');
    LB_PREVIEW_DATA = body.data;
  } catch (e) {
    console.warn('[lb] preview load failed', e);
    LB_PREVIEW_DATA = null;
  }
}
function lbFormatValue(value, metric) {
  if (metric === 'lifetime_spend') return acWrap(Number(value || 0).toFixed(0));
  if (metric === 'points_balance') return Number(value || 0).toLocaleString() + ' pts';
  if (metric === 'orders_count')   return Number(value || 0).toLocaleString() + ' orders';
  return String(value || 0);
}
function lbMetricLabel(metric) {
  if (metric === 'points_balance') return 'By points balance';
  if (metric === 'orders_count')   return 'By paid orders';
  return 'By lifetime spend';
}
function lbPeriodLabel(period) {
  if (period === 'year')  return 'Last 12 months';
  if (period === 'month') return 'Last 30 days';
  if (period === 'week')  return 'Last 7 days';
  return 'All time';
}
function lbMaskNickname(name, mode) {
  const s = String(name || '').trim();
  if (!s) return mode === 'masked' ? '会员' : 'Member';
  if (mode === 'full') return s;
  if (mode === 'first_char') {
    const chars = Array.from(s);
    if (chars.length <= 1) return chars[0] + '*';
    return chars[0] + '*'.repeat(Math.min(3, chars.length - 1));
  }
  return '**';
}
function lbEscapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function lbRenderPreview() {
  const f = lbReadForm();
  $('#lb-pv-kicker').textContent   = f.kicker_en || 'ROOTS CLUB · LEADERBOARD';
  $('#lb-pv-title').textContent    = f.title_en  || 'Top growers';
  $('#lb-pv-subhead').textContent  = f.subhead_en || '';
  $('#lb-pv-meta').textContent     = lbMetricLabel(f.metric) + ' · ' + lbPeriodLabel(f.period);
  const note = $('#lb-period-note');
  if (note) note.textContent = (f.metric === 'points_balance')
    ? cuT('Note: points-balance metric is point-in-time. Period selector is ignored for this metric.', '说明:积分余额为实时快照指标,该指标会忽略周期选择。')
    : '';
  let rawEntries = ((LB_PREVIEW_DATA && LB_PREVIEW_DATA.raw_entries) || []).slice();
  // Drop hidden real members client-side so the preview reacts to unsaved
  // edits to the hide field (matched case-insensitively).
  const hideSet = new Set((f.hide_names || []).map(n => String(n).trim().toLowerCase()).filter(Boolean));
  if (hideSet.size) rawEntries = rawEntries.filter(e => !hideSet.has(String(e.nickname || '').trim().toLowerCase()));
  // Blend placeholder members into the preview client-side so the operator
  // sees them immediately (the server only includes them after a save).
  const seedBox = $('#lb-seed-enabled');
  if (seedBox && seedBox.checked && LB_SEED_ENTRIES.length) {
    rawEntries = rawEntries
      .map(e => ({ nickname: e.nickname, value: Number(e.value) || 0 }))
      .concat(LB_SEED_ENTRIES.map(s => ({ nickname: s.name, value: Number(s.value) || 0 })))
      .sort((a, b) => b.value - a.value)
      .map((e, i) => ({ ...e, rank: i + 1 }));
  }
  const topN = Math.max(1, Math.min(100, parseInt(f.top_n, 10) || 20));
  const sliced = rawEntries.slice(0, topN);
  const list = $('#lb-pv-list');
  if (!sliced.length) {
    list.innerHTML = '<div class="lb-pv-empty">No qualifying members yet. Save the config and customers with activity will appear here.</div>';
  } else {
    list.innerHTML = sliced.map(e => {
      const rankClass = e.rank === 1 ? 'gold' : e.rank === 2 ? 'silver' : e.rank === 3 ? 'bronze' : '';
      const name = lbMaskNickname(e.nickname, f.reveal_mode);
      return '<div class="lb-pv-row">' +
             '<div class="lb-pv-rank ' + rankClass + '">#' + e.rank + '</div>' +
             '<div>' + lbEscapeHtml(name) + '</div>' +
             '<div class="lb-pv-val">' + lbFormatValue(e.value, f.metric) + '</div>' +
             '</div>';
    }).join('');
  }
  const rewards = $('#lb-pv-rewards');
  const parts = [];
  if (f.reward_top1_en)  parts.push({ tag: 'Top 1',  text: f.reward_top1_en });
  if (f.reward_top3_en)  parts.push({ tag: 'Top 3',  text: f.reward_top3_en });
  if (f.reward_top10_en) parts.push({ tag: 'Top 10', text: f.reward_top10_en });
  rewards.innerHTML = parts.map(p =>
    '<div class="lb-reward"><span class="lb-r-tag">' + lbEscapeHtml(p.tag) + '</span> · ' + lbEscapeHtml(p.text) + '</div>'
  ).join('');
  lbUpdateEnabledPill();
}
function updateLeaderboardPreview() { lbRenderPreview(); }

// The Visibility switch is the master on/off — flipping it must persist
// immediately (the rest of the form still saves via the Save button). Without
// this, a flip was preview-only and reverted to the stored value on refresh.
async function lbToggleEnabled() {
  lbRenderPreview();          // reflect the new state in the pill + preview now
  await saveLeaderboardConfig();
}

async function saveLeaderboardConfig() {
  const body = lbReadForm();
  const status = $('#lb-save-status');
  if (status) status.textContent = 'Saving…';
  try {
    const r = await fetch('/api/retail-admin/leaderboard/config', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!data.success) throw new Error(data.error || 'save_failed');
    lbApplyConfigToForm(data.data);
    if (status) status.textContent = cuT('Saved', '已保存') + ' · ' + new Date().toLocaleTimeString();
    toast('Leaderboard saved · 排行榜已保存');
    await lbLoadPreview();
    lbRenderPreview();
  } catch (e) {
    console.warn('[lb] save failed', e);
    if (status) status.textContent = 'Save failed · 保存失败: ' + e.message;
    toast('Save failed · 保存失败: ' + e.message);
  }
}

document.querySelector('[data-tab="leaderboard"]').addEventListener('click', () => {
  if (!LB_LOADED) { LB_LOADED = true; lbLoad(); }
});

// ════════════════════════════════════════════════════════════════
// VOTING — community polls. Admin builds, opens, closes, and picks
// winners. Lazy-loaded on first tab open.
// ════════════════════════════════════════════════════════════════
let POLLS_LOADED = false;
let _pollsCache = [];                // last server snapshot
let _pollDraft  = null;              // { id?, ...form state } while editing

const POLL_PALETTE = [
  '#F2CA6C', '#F4B8CB', '#F4F087', '#E96174',
  '#B2CFED', '#7BBD3B', '#A8D185', '#FFAF60',
];

function pollLetter(i) { return String.fromCharCode(65 + i); }

function pollStatusPill(status) {
  return `<span class="vot-stat ${status}">${status}</span>`;
}

// Mirror "any poll currently open" onto the Voting nav row as an OPEN pill,
// the same way body.lb-off drives Leaderboard's OFF pill.
function votUpdateNavState() {
  const anyOpen = (_pollsCache || []).some(p => p.status === 'open');
  document.body.classList.toggle('vot-open', anyOpen);
}
// Seed the nav OPEN pill at startup so it reflects reality before the operator
// ever opens the Voting tab (the full list lazy-loads on first tab open).
async function votInitNavState() {
  try {
    const r = await fetch('/api/retail-admin/polls', { credentials: 'same-origin' });
    const b = await r.json();
    const polls = (b && (b.data || b)) || [];
    document.body.classList.toggle('vot-open', Array.isArray(polls) && polls.some(p => p.status === 'open'));
  } catch (e) { /* leave nav as-is if the probe fails */ }
}

async function loadPolls() {
  try {
    const r = await api('/api/retail-admin/polls');
    _pollsCache = r.data || [];
    votUpdateNavState();
    renderPollList();
  } catch (e) {
    $('#vot-list').innerHTML = `<div class="muted" style="color: #c64242;">${cuT('Failed to load', '加载失败')}: <span data-no-i18n>${escapeHtml(e.message)}</span></div>`;
  }
}

function renderPollList() {
  const mount = $('#vot-list');
  if (!_pollsCache.length) {
    mount.innerHTML = '<div class="muted" style="font-size: 12px;">No polls yet. Click <b>+ New poll</b> to create one.</div>';
    return;
  }
  mount.innerHTML = _pollsCache.map(p => {
    const top = (p.options || [])
      .slice()
      .sort((a, b) => (b.votes || 0) - (a.votes || 0))[0];
    const meta = [
      `${(p.options || []).length} ${cuT('opts', '选项')}`,
      `${p.total_votes || 0} ${cuT('votes', '票')}`,
      p.reward_points ? `+${p.reward_points} ${cuT('pts', '积分')}` : null,
      p.closes_at ? `${cuT('closes', '截止')} ${String(p.closes_at).slice(0, 16).replace('T', ' ')}` : null,
      top && (p.status !== 'open' || p.total_votes > 0) ? `${cuT('top:', '领先:')} ${escapeHtml(top.label_en)}` : null,
    ].filter(Boolean).join(' · ');
    return `
      <div class="vot-row" data-id="${p.id}">
        <div style="min-width: 0; flex: 1;">
          <div class="vot-q">${escapeHtml(p.question_en || '(untitled)')}</div>
          <div class="vot-meta">${escapeHtml(meta)}</div>
        </div>
        ${p.is_featured ? '<span class="vot-featured">Featured · 精选</span>' : ''}
        ${pollStatusPill(p.status)}
        <div class="vot-actions">
          <button class="btn" onclick="editPoll(${p.id})">Edit · 编辑</button>
          ${p.status === 'draft' ? `<button class="btn btn-primary" onclick="quickPollStatus(${p.id}, 'open')">Open · 开启</button>` : ''}
          ${p.status === 'open'  ? `<button class="btn" onclick="quickPollStatus(${p.id}, 'closed')">Close · 关闭</button>` : ''}
          ${p.status === 'closed'? `<button class="btn" onclick="quickPollStatus(${p.id}, 'open')">Reopen · 重新开启</button>` : ''}
          <button class="btn danger" onclick="deletePoll(${p.id})">Delete · 删除</button>
        </div>
      </div>
    `;
  }).join('');
}

function newPoll() {
  _pollDraft = {
    id: null,
    question_en: '', question_cn: '',
    explainer_en: '', explainer_cn: '',
    category_en: '', category_cn: '',
    status: 'draft',
    closes_at: '',
    reward_points: 5,
    is_featured: 0,
    sort_order: 0,
    winner_option_id: null,
    options: [
      { label_en: '', label_cn: '', color_hex: POLL_PALETTE[0], votes: 0 },
      { label_en: '', label_cn: '', color_hex: POLL_PALETTE[1], votes: 0 },
    ],
  };
  renderPollForm();
}

function editPoll(id) {
  const p = _pollsCache.find(x => x.id === id);
  if (!p) return;
  _pollDraft = JSON.parse(JSON.stringify(p));
  _pollDraft.closes_at = _pollDraft.closes_at ? String(_pollDraft.closes_at).slice(0, 16).replace(' ', 'T') : '';
  if (!Array.isArray(_pollDraft.options)) _pollDraft.options = [];
  renderPollForm();
}

function renderPollForm() {
  const d = _pollDraft;
  if (!d) { $('#vot-form-mount').innerHTML = ''; return; }
  const isEdit = !!d.id;
  const hasVotes = (d.options || []).some(o => (o.votes || 0) > 0);
  const realTotal = (d.options || []).reduce((s, o) => s + (o.votes || 0), 0);
  const optsHtml = (d.options || []).map((o, i) => `
    <div class="vot-opt" data-idx="${i}">
      <div class="vot-opt-letter">${pollLetter(i)}</div>
      <input type="text" placeholder="Label · EN" value="${escapeAttr(o.label_en || '')}" oninput="pollOptEdit(${i}, 'label_en', this.value)"/>
      <input type="text" placeholder="标签 · 中文" value="${escapeAttr(o.label_cn || '')}" oninput="pollOptEdit(${i}, 'label_cn', this.value)"/>
      <div class="vot-opt-color">
        <input type="color" value="${escapeAttr(o.color_hex || '#CCD900')}" oninput="pollOptEdit(${i}, 'color_hex', this.value)" title="Card color"/>
        <input type="text" value="${escapeAttr(o.color_hex || '')}" placeholder="#hex" oninput="pollOptEdit(${i}, 'color_hex', this.value)" style="width: 70px; font-size: 11px;"/>
      </div>
      <div class="vot-opt-votes">${(o.votes || 0)} votes</div>
      <button class="btn vot-opt-rm" onclick="pollOptRemove(${i})" title="Remove option"${(o.votes || 0) > 0 ? ' disabled style="opacity:.4;cursor:not-allowed"' : ''}>×</button>
    </div>
  `).join('');

  const winnerOpts = (d.options || []).map((o, i) =>
    `<option value="${o.id || ''}" ${String(d.winner_option_id || '') === String(o.id || '') ? 'selected' : ''}>${pollLetter(i)} · ${escapeHtml(o.label_en || '(unnamed)')}</option>`
  ).join('');

  $('#vot-form-mount').innerHTML = `
    <div class="vot-form">
      <h3>${isEdit ? cuT('Edit poll', '编辑投票') + ' #' + d.id : cuT('New poll', '新建投票')}</h3>
      <div class="muted" style="font-size: 11px;">Question + options are required (min 2 options). Customers see polls with status <code>open</code> or <code>closed</code>; <code>draft</code> stays hidden. · 问题与选项为必填(至少 2 个选项)。顾客只能看到状态为 <code>open</code> 或 <code>closed</code> 的投票;<code>draft</code> 始终隐藏。</div>

      <div class="vot-row-2">
        <div class="field">
          <label>Question · EN <span style="color:#c64242">*</span></label>
          <input type="text" id="vot-q-en" value="${escapeAttr(d.question_en || '')}" placeholder="Which kombucha flavor next?"/>
        </div>
        <div class="field">
          <label>问题 · 中文</label>
          <input type="text" id="vot-q-cn" value="${escapeAttr(d.question_cn || '')}" placeholder="下款康普茶应该是哪个口味?"/>
        </div>
      </div>

      <div class="vot-row-2">
        <div class="field">
          <label>Category kicker · EN · 分类引题 · 英文</label>
          <input type="text" id="vot-cat-en" value="${escapeAttr(d.category_en || '')}" placeholder="NEW FLAVOR"/>
        </div>
        <div class="field">
          <label>类别 · 中文</label>
          <input type="text" id="vot-cat-cn" value="${escapeAttr(d.category_cn || '')}" placeholder="新口味"/>
        </div>
      </div>

      <div class="vot-row-2">
        <div class="field">
          <label>Explainer · EN <span class="muted" style="font-weight: normal; letter-spacing: 0;">(italic line under the question) · (问题下方的斜体说明行)</span></label>
          <textarea id="vot-exp-en" placeholder="You spoke, we listened — Mango sold out. Pick what we develop next.">${escapeHtml(d.explainer_en || '')}</textarea>
        </div>
        <div class="field">
          <label>说明 · 中文</label>
          <textarea id="vot-exp-cn">${escapeHtml(d.explainer_cn || '')}</textarea>
        </div>
      </div>

      <div class="field">
        <label>Options · 选项 <span class="muted" style="font-weight: normal; letter-spacing: 0;">(drag is server-side via sort_order; reorder by editing — first row becomes A) · (排序由服务端的 sort_order 决定;通过编辑来调整顺序——第一行即为 A)</span></label>
        <div class="vot-opts">${optsHtml}</div>
        <div style="margin-top: 6px;">
          <button class="btn" onclick="pollOptAdd()" ${d.options.length >= 8 ? 'disabled' : ''}>+ Add option · 添加选项</button>
          <span class="muted" style="font-size: 11px; margin-left: 8px;">${d.options.length}/8 options</span>
          ${hasVotes ? '<span class="muted" style="font-size: 11px; margin-left: 8px;">· options with votes can\'t be removed individually — use the "Hard reset" toggle below to wipe all votes · 含有投票的选项不能单独删除——请用下方“硬重置”开关清空所有投票</span>' : ''}
        </div>
      </div>

      <div class="vot-row-2">
        <div class="field">
          <label>Status · 状态</label>
          <select id="vot-status">
            <option value="draft"  ${d.status === 'draft'  ? 'selected' : ''}>Draft (hidden) · 草稿(隐藏)</option>
            <option value="open"   ${d.status === 'open'   ? 'selected' : ''}>Open · accepting votes · 进行中 · 接受投票</option>
            <option value="closed" ${d.status === 'closed' ? 'selected' : ''}>Closed · show result · 已结束 · 显示结果</option>
          </select>
        </div>
        <div class="field">
          <label>Reward points · 投票积分奖励</label>
          <input type="number" id="vot-reward" value="${d.reward_points != null ? d.reward_points : 5}" min="0" max="100"/>
        </div>
      </div>

      <div class="vot-row-2">
        <div class="field">
          <label>Closes at <span class="muted" style="font-weight: normal; letter-spacing: 0;">(cosmetic — shown as "N days left")</span></label>
          <input type="datetime-local" id="vot-closes" value="${escapeAttr(d.closes_at || '')}"/>
        </div>
        <div class="field">
          <label>Featured? · 精选? <span class="muted" style="font-weight: normal; letter-spacing: 0;">(promotes this poll to the big top card) · (将此投票提升为顶部大卡片)</span></label>
          <select id="vot-featured">
            <option value="0" ${!d.is_featured ? 'selected' : ''}>No · 否</option>
            <option value="1" ${d.is_featured  ? 'selected' : ''}>Featured · 精选</option>
          </select>
        </div>
      </div>

      <div class="field">
        <label>Show vote count as · 对外显示票数 <span class="muted" style="font-weight: normal; letter-spacing: 0;">(0 = show the real count) · (0 = 显示真实票数)</span></label>
        <input type="number" id="vot-display-min" min="0" max="100000"
               value="${d.display_min_total != null ? d.display_min_total : 0}"
               oninput="pollBoostPreview()"/>
        <div class="muted" id="vot-display-preview" style="font-size: 11px; margin-top: 4px;"></div>
        <div class="muted" style="font-size: 11px;">Customers see at least this many votes — every option is scaled up by the same factor, so the percentages and the winner stay identical. The real count (<b>${realTotal}</b>) is unchanged here in the office and in your data. · 顾客至少看到这么多票;所有选项按同一比例放大,百分比与领先项不变。真实票数(<b>${realTotal}</b>)在后台与数据中保持不变。</div>
      </div>

      ${isEdit ? `
      <div class="vot-row-2">
        <div class="field">
          <label>Winner option · 获胜选项 <span class="muted" style="font-weight: normal; letter-spacing: 0;">(only used when Closed) · (仅在已结束时生效)</span></label>
          <select id="vot-winner">
            <option value="">— (auto: highest vote count) · —(自动:票数最高)</option>
            ${winnerOpts}
          </select>
        </div>
        <div class="field">
          <label>Sort order · 排序 <span class="muted" style="font-weight: normal; letter-spacing: 0;">(lower appears first within status) · (数值越小在同状态内越靠前)</span></label>
          <input type="number" id="vot-sort" value="${d.sort_order || 0}"/>
        </div>
      </div>

      ${hasVotes ? `
      <div class="field">
        <label class="danger" style="display: flex; align-items: center; gap: 8px;">
          <input type="checkbox" id="vot-replace-opts"/> Hard reset options · 硬重置选项 (clears all ${d.total_votes || 0} votes · 将清空全部 ${d.total_votes || 0} 票)
        </label>
        <div class="muted" style="font-size: 11px;">Use this only when reworking the question entirely. Otherwise just edit labels in place — vote counts are preserved. · 仅在彻底改写问题时使用;否则直接就地编辑文本即可,投票数会保留。</div>
      </div>
      ` : ''}
      ` : `
      <div class="field">
        <label>Sort order · 排序</label>
        <input type="number" id="vot-sort" value="${d.sort_order || 0}"/>
      </div>
      `}

      <div class="vot-form-actions">
        <button class="btn btn-primary" onclick="savePoll()">${isEdit ? cuT('Save changes', '保存更改') : cuT('Create poll', '创建投票')}</button>
        <button class="btn" onclick="cancelPollEdit()">Cancel · 取消</button>
        <div style="flex: 1"></div>
        ${isEdit ? `<button class="btn danger" onclick="deletePoll(${d.id})">Delete · 删除</button>` : ''}
      </div>
    </div>
  `;
  pollBoostPreview();   // seed the "real → shown" hint for the loaded value
}

function pollOptEdit(i, field, value) {
  if (!_pollDraft) return;
  if (!_pollDraft.options[i]) return;
  _pollDraft.options[i][field] = value;
  // Don't re-render on every keystroke — only on structural changes.
}

// Live "real → shown" preview under the display-vote-count input. Mirrors the
// server's applyPollDisplayBoost exactly: scale every option by the same factor
// when the floor is above real turnout; never shrink; no ratio to inflate at 0.
function pollBoostPreview() {
  const out = $('#vot-display-preview');
  if (!out || !_pollDraft) return;
  const opts = _pollDraft.options || [];
  const realTotal = opts.reduce((s, o) => s + (o.votes || 0), 0);
  const floor = Math.max(0, parseInt($('#vot-display-min')?.value, 10) || 0);
  if (!floor || realTotal <= 0 || floor <= realTotal) {
    out.innerHTML = realTotal > 0
      ? cuT(`Showing the real ${realTotal} votes.`, `按真实票数 ${realTotal} 显示。`)
      : cuT('No votes yet — nothing to scale until the first real vote.', '暂无投票 — 在首次真实投票前不会放大。');
    return;
  }
  const factor = floor / realTotal;
  let shown = 0;
  const parts = opts.map(o => {
    const v = Math.round((o.votes || 0) * factor);
    shown += v;
    return `${escapeHtml(o.label_en || '?')} ${o.votes || 0}→<b>${v}</b>`;
  });
  out.innerHTML = cuT(
    `Customers will see ~<b>${shown}</b> votes (×${factor.toFixed(1)}): `,
    `顾客将看到约 <b>${shown}</b> 票(×${factor.toFixed(1)}):`
  ) + parts.join(' · ');
}

function pollOptAdd() {
  if (!_pollDraft) return;
  if (_pollDraft.options.length >= 8) return;
  const i = _pollDraft.options.length;
  _pollDraft.options.push({
    label_en: '', label_cn: '',
    color_hex: POLL_PALETTE[i % POLL_PALETTE.length],
    votes: 0,
  });
  renderPollForm();
}

function pollOptRemove(i) {
  if (!_pollDraft) return;
  if ((_pollDraft.options[i]?.votes || 0) > 0) return;
  _pollDraft.options.splice(i, 1);
  renderPollForm();
}

function _collectPollFormState() {
  const d = _pollDraft;
  if (!d) return null;
  const out = {
    question_en:  $('#vot-q-en').value.trim(),
    question_cn:  $('#vot-q-cn').value.trim(),
    category_en:  $('#vot-cat-en').value.trim(),
    category_cn:  $('#vot-cat-cn').value.trim(),
    explainer_en: $('#vot-exp-en').value.trim(),
    explainer_cn: $('#vot-exp-cn').value.trim(),
    status:       $('#vot-status').value,
    reward_points: Math.max(0, parseInt($('#vot-reward').value, 10) || 0),
    is_featured:  $('#vot-featured').value === '1' ? 1 : 0,
    closes_at:    $('#vot-closes').value || null,
    sort_order:   parseInt($('#vot-sort').value, 10) || 0,
    display_min_total: Math.max(0, parseInt($('#vot-display-min')?.value, 10) || 0),
    options:      d.options.map((o, i) => ({
      id:         o.id || null,
      label_en:   String(o.label_en || '').trim(),
      label_cn:   String(o.label_cn || '').trim(),
      color_hex:  String(o.color_hex || '').trim(),
      image_url:  String(o.image_url || '').trim(),
      sort_order: i,
    })),
  };
  if (d.id) {
    const winSel = $('#vot-winner');
    if (winSel) out.winner_option_id = winSel.value ? parseInt(winSel.value, 10) : null;
    const replace = $('#vot-replace-opts');
    if (replace) out.replace_options = !!replace.checked;
  }
  return out;
}

async function savePoll() {
  if (!_pollDraft) return;
  const body = _collectPollFormState();
  if (!body.question_en) { toast('Question (EN) is required · 英文问题必填', 'err'); return; }
  const realOpts = body.options.filter(o => o.label_en);
  if (realOpts.length < 2) { toast('At least 2 options required · 至少需要 2 个选项', 'err'); return; }
  body.options = realOpts;

  try {
    if (_pollDraft.id) {
      await api('/api/retail-admin/polls/' + _pollDraft.id, { method: 'PUT', body });
      toast('Poll saved · 投票已保存');
    } else {
      await api('/api/retail-admin/polls', { method: 'POST', body });
      toast('Poll created · 投票已创建');
    }
    _pollDraft = null;
    $('#vot-form-mount').innerHTML = '';
    await loadPolls();
  } catch (e) {
    toast('Save failed · 保存失败: ' + e.message, 'err');
  }
}

function cancelPollEdit() {
  _pollDraft = null;
  $('#vot-form-mount').innerHTML = '';
}

async function quickPollStatus(id, status) {
  if (status === 'open' && !(await askConfirm({ title: 'Publish this poll? Customers will see it immediately and start earning points for voting. · 发布此投票?顾客会立即看到并通过投票获得积分。', confirmLabel: 'Publish poll' }))) return;
  if (status === 'closed' && !(await askConfirm({ title: 'Close this poll? Voting will be locked. · 关闭此投票?投票将被锁定。', confirmLabel: 'Close poll' }))) return;
  try {
    await api('/api/retail-admin/polls/' + id, { method: 'PUT', body: { status } });
    toast('Poll → · 投票状态 → ' + status);
    await loadPolls();
  } catch (e) { toast(cuT('Failed', '失败') + ': ' + e.message, 'err'); }
}

async function deletePoll(id) {
  if (!(await askConfirm({ title: 'Delete this poll? All vote records are removed too. · 删除此投票?所有投票记录也将一并删除。', confirmLabel: 'Delete poll', danger: true }))) return;
  try {
    await api('/api/retail-admin/polls/' + id, { method: 'DELETE' });
    if (_pollDraft && _pollDraft.id === id) {
      _pollDraft = null;
      $('#vot-form-mount').innerHTML = '';
    }
    toast('Poll deleted · 投票已删除');
    await loadPolls();
  } catch (e) { toast('Delete failed · 删除失败: ' + e.message, 'err'); }
}

// Intro tagline editor — the line shown under the "Your say" headline.
// Stored under storefront_config.voting.config; read live by the mini app.
async function loadVotingConfig() {
  try {
    const r = await api('/api/retail-admin/voting/config');
    const c = r.data || {};
    const en = $('#vot-intro-en'), cn = $('#vot-intro-cn'), sc = $('#vot-show-counts');
    if (en) en.value = c.intro_en || '';
    if (cn) cn.value = c.intro_cn || '';
    if (sc) sc.checked = c.show_counts !== false;
  } catch (e) { /* leave placeholders if the load fails */ }
}

async function saveVotingConfig(btn) {
  if (btn) btn.disabled = true;
  try {
    await api('/api/retail-admin/voting/config', {
      method: 'PUT',
      body: {
        intro_en: $('#vot-intro-en').value.trim(),
        intro_cn: $('#vot-intro-cn').value.trim(),
        show_counts: !!($('#vot-show-counts') && $('#vot-show-counts').checked),
      },
    });
    toast('Saved · 已保存');
  } catch (e) {
    toast('Save failed · 保存失败: ' + e.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

document.querySelector('[data-tab="voting"]').addEventListener('click', () => {
  if (!POLLS_LOADED) { POLLS_LOADED = true; loadPolls(); loadVotingConfig(); }
});

// ─── About page editor ─────────────────────────────────────────────────
// Stored as one JSON blob under storefront_config.about.content. The
// mini app reads it from /api/retail/config and renders pages/about/about.
let ABOUT_LOADED = false;
let ABOUT_STATE = null;

const ABOUT_DEFAULTS = {
  kicker_en: 'WHO WE ARE',
  kicker_cn: '我们是谁',
  manifesto_en: 'We exist to make **plant-based food** so mind blowing good it transforms how people eat, how they see plants, and how we create a better, more sustainable future — without ever giving up flavor, health, or joy!',
  manifesto_cn: '我们存在的意义,是把**植物食物**做到令人惊艳的好——好到改变人们的饮食方式、对植物的认知,也改变我们共同走向更可持续未来的方式——而风味、健康与快乐,一样也不放下。',
  stats: [
    { value_en: '2017', value_cn: '2017', label_en: 'EST.',     label_cn: '成立' },
    { value_en: '广州', value_cn: '广州', label_en: 'MADE IN',  label_cn: '产地' },
    { value_en: '50+',  value_cn: '50+',  label_en: 'PRODUCTS', label_cn: '产品' },
    { value_en: '100%', value_cn: '100%', label_en: 'PLANT',    label_cn: '植物' },
  ],
  founder_kicker_en: 'MEET THE FOUNDER',
  founder_kicker_cn: '创始人',
  founder_name_en: 'Founder Name',
  founder_name_cn: '创始人姓名',
  founder_title_en: 'FOUNDER & CEO',
  founder_title_cn: '创始人兼首席执行官',
  founder_quote_en: 'I started Roots because I wanted to prove that plants don\'t have to be the boring option.',
  founder_quote_cn: '我创立 Roots,是想证明植物从来不该是无聊的选择。',
  founder_photo_url: '',
  promise_kicker_en: 'OUR PROMISE',
  promise_kicker_cn: '我们的承诺',
  in_items: [
    { en: '100% plant-based',     cn: '100% 植物' },
    { en: 'Made from scratch',    cn: '原料自制' },
    { en: 'Real fermentation',    cn: '真发酵' },
    { en: 'Whole ingredients',    cn: '完整食材' },
    { en: 'Small batch',          cn: '小批量' },
    { en: 'Seasonal',             cn: '应季' },
    { en: 'Local-first · 广州',   cn: '本地优先' },
    { en: 'Recyclable packaging', cn: '可回收包装' },
  ],
  out_items: [
    { en: 'Preservatives',     cn: '防腐剂' },
    { en: 'Refined sugar',     cn: '精制糖' },
    { en: 'Artificial color',  cn: '人造色素' },
    { en: 'Artificial flavor', cn: '人造香精' },
    { en: 'Additives',         cn: '添加剂' },
    { en: 'GMO',               cn: '转基因' },
    { en: 'Animal products',   cn: '动物产品' },
    { en: 'Cutting corners',   cn: '走捷径' },
  ],
  outro_en: 'From soil to soul.',
  outro_cn: '从土壤到灵魂',
  cta_en: 'SHOP NOW',
  cta_cn: '立即购买',
};

async function loadAbout() {
  try {
    const { data } = await api('/api/retail/config');
    const stored = data?.about?.content;
    ABOUT_STATE = stored && typeof stored === 'object'
      ? { ...ABOUT_DEFAULTS, ...stored }
      : { ...ABOUT_DEFAULTS };
    // Make sure arrays exist
    if (!Array.isArray(ABOUT_STATE.stats))     ABOUT_STATE.stats     = ABOUT_DEFAULTS.stats.slice();
    if (!Array.isArray(ABOUT_STATE.in_items))  ABOUT_STATE.in_items  = ABOUT_DEFAULTS.in_items.slice();
    if (!Array.isArray(ABOUT_STATE.out_items)) ABOUT_STATE.out_items = ABOUT_DEFAULTS.out_items.slice();
    paintAbout();
  } catch (e) {
    console.warn('about load failed', e);
    ABOUT_STATE = { ...ABOUT_DEFAULTS };
    paintAbout();
  }
}

function paintAbout() {
  const a = ABOUT_STATE;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ''; };
  set('about-kicker-en', a.kicker_en);
  set('about-kicker-cn', a.kicker_cn);
  set('about-manifesto-en', a.manifesto_en);
  set('about-manifesto-cn', a.manifesto_cn);
  set('about-founder-kicker-en', a.founder_kicker_en);
  set('about-founder-kicker-cn', a.founder_kicker_cn);
  set('about-founder-name-en', a.founder_name_en);
  set('about-founder-name-cn', a.founder_name_cn);
  set('about-founder-title-en', a.founder_title_en);
  set('about-founder-title-cn', a.founder_title_cn);
  set('about-founder-quote-en', a.founder_quote_en);
  set('about-founder-quote-cn', a.founder_quote_cn);
  set('about-promise-kicker-en', a.promise_kicker_en);
  set('about-promise-kicker-cn', a.promise_kicker_cn);
  set('about-outro-en', a.outro_en);
  set('about-outro-cn', a.outro_cn);
  set('about-cta-en', a.cta_en);
  set('about-cta-cn', a.cta_cn);
  paintAboutPhoto();
  paintAboutStats();
  paintAboutBullets();
}

function paintAboutPhoto() {
  const wrap = document.getElementById('about-founder-photo-preview');
  const url = ABOUT_STATE.founder_photo_url || '';
  if (url) {
    wrap.innerHTML = `<img src="${escapeAttr(url)}" alt="Founder">`;
  } else {
    wrap.innerHTML = '<div class="ab-photo-empty">No photo — placeholder tile will show. · 暂无照片 — 将显示占位图块。</div>';
  }
}

function paintAboutStats() {
  const tbody = document.getElementById('about-stats-tbody');
  tbody.innerHTML = ABOUT_STATE.stats.map((s, i) => `
    <tr>
      <td style="width:30px;color:var(--text-3,#888);font-size:12px;">${i + 1}</td>
      <td><input type="text" value="${escapeAttr(s.value_en || '')}" oninput="ABOUT_STATE.stats[${i}].value_en=this.value"></td>
      <td><input type="text" value="${escapeAttr(s.value_cn || '')}" oninput="ABOUT_STATE.stats[${i}].value_cn=this.value"></td>
      <td><input type="text" value="${escapeAttr(s.label_en || '')}" oninput="ABOUT_STATE.stats[${i}].label_en=this.value"></td>
      <td><input type="text" value="${escapeAttr(s.label_cn || '')}" oninput="ABOUT_STATE.stats[${i}].label_cn=this.value"></td>
    </tr>
  `).join('');
}

function paintAboutBullets() {
  for (const which of ['in', 'out']) {
    const tbody = document.getElementById(`about-${which}-tbody`);
    const arr = ABOUT_STATE[`${which}_items`];
    tbody.innerHTML = arr.map((it, i) => `
      <tr>
        <td style="width:24px;color:var(--text-3,#888);font-size:11px;">${i + 1}</td>
        <td><input type="text" value="${escapeAttr(it.en || '')}" oninput="ABOUT_STATE.${which}_items[${i}].en=this.value"></td>
        <td><input type="text" value="${escapeAttr(it.cn || '')}" oninput="ABOUT_STATE.${which}_items[${i}].cn=this.value"></td>
        <td style="width:32px;"><button class="btn btn-sm" onclick="aboutRemoveBullet('${which}', ${i})">×</button></td>
      </tr>
    `).join('');
  }
}

function aboutAddBullet(which) {
  ABOUT_STATE[`${which}_items`].push({ en: '', cn: '' });
  paintAboutBullets();
}
function aboutRemoveBullet(which, i) {
  ABOUT_STATE[`${which}_items`].splice(i, 1);
  paintAboutBullets();
}

function collectAbout() {
  const get = id => document.getElementById(id)?.value || '';
  return {
    kicker_en: get('about-kicker-en'),
    kicker_cn: get('about-kicker-cn'),
    manifesto_en: get('about-manifesto-en'),
    manifesto_cn: get('about-manifesto-cn'),
    stats: ABOUT_STATE.stats.map(s => ({
      value_en: s.value_en || '', value_cn: s.value_cn || '',
      label_en: s.label_en || '', label_cn: s.label_cn || '',
    })),
    founder_kicker_en: get('about-founder-kicker-en'),
    founder_kicker_cn: get('about-founder-kicker-cn'),
    founder_name_en: get('about-founder-name-en'),
    founder_name_cn: get('about-founder-name-cn'),
    founder_title_en: get('about-founder-title-en'),
    founder_title_cn: get('about-founder-title-cn'),
    founder_quote_en: get('about-founder-quote-en'),
    founder_quote_cn: get('about-founder-quote-cn'),
    founder_photo_url: ABOUT_STATE.founder_photo_url || '',
    promise_kicker_en: get('about-promise-kicker-en'),
    promise_kicker_cn: get('about-promise-kicker-cn'),
    in_items:  ABOUT_STATE.in_items.map(it  => ({ en: it.en || '', cn: it.cn || '' })),
    out_items: ABOUT_STATE.out_items.map(it => ({ en: it.en || '', cn: it.cn || '' })),
    outro_en: get('about-outro-en'),
    outro_cn: get('about-outro-cn'),
    cta_en: get('about-cta-en'),
    cta_cn: get('about-cta-cn'),
  };
}

async function saveAbout() {
  const status = document.getElementById('about-save-status');
  status.textContent = 'Saving…';
  try {
    const next = collectAbout();
    ABOUT_STATE = { ...ABOUT_STATE, ...next };
    await api('/api/retail-admin/config', {
      method: 'PUT',
      body: { 'about.content': next },
    });
    status.textContent = 'Saved · ' + new Date().toLocaleTimeString();
    toast('About page saved · 已保存');
  } catch (e) {
    status.textContent = 'Save failed · 保存失败: ' + e.message;
    toast('Save failed · 保存失败: ' + e.message, 'err');
  }
}

// Photo upload — uses the CMS media endpoint (multipart, field 'file').
document.getElementById('about-founder-photo-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) { toast('Image too large (max 4MB) · 图片过大(上限 4MB)', 'err'); return; }
  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/retail-admin/cms/media', {
      method: 'POST', body: fd, credentials: 'same-origin',
    });
    const j = await res.json();
    if (!j.success) throw new Error(j.error || 'upload_failed');
    ABOUT_STATE.founder_photo_url = j.data.url || ('/api/retail/media/' + j.data.id);
    paintAboutPhoto();
    toast('Photo uploaded — remember to Save · 图片已上传 — 记得点保存');
  } catch (err) {
    toast('Upload failed · 上传失败: ' + err.message, 'err');
  }
  e.target.value = '';
});

document.getElementById('about-founder-photo-clear').addEventListener('click', () => {
  ABOUT_STATE.founder_photo_url = '';
  paintAboutPhoto();
});

document.querySelector('[data-tab="about"]').addEventListener('click', () => {
  if (!ABOUT_LOADED) { ABOUT_LOADED = true; loadAbout(); }
});

let MEDIA_LOADED = false;
document.querySelector('[data-tab="media"]').addEventListener('click', () => {
  if (!MEDIA_LOADED) { MEDIA_LOADED = true; loadMedia(); }
});

// ─── Live Preview drawer ────────────────────────────────────────────────
// Embeds /storefront in a phone-shaped iframe inside a side drawer so
// the user can sanity-check CMS / catalog changes without leaving the
// Backend. Iframe is mounted lazily on first open; subsequent opens
// reuse it. "Refresh" reloads the iframe (handy after publishing CMS
// edits). "Open in new tab" lets the user pop it out if they prefer.
function openLivePreview() {
  const drawer = document.getElementById('live-preview-drawer');
  const mount  = document.getElementById('live-preview-mount');
  if (!drawer || !mount) return;
  if (!mount.querySelector('iframe')) {
    const ifr = document.createElement('iframe');
    ifr.id = 'live-preview-iframe';
    ifr.src = '/storefront?preview=1';
    ifr.title = 'Live storefront preview';
    ifr.setAttribute('loading', 'lazy');
    mount.appendChild(ifr);
  }
  openDrawer('#live-preview-drawer');
}
function reloadLivePreview() {
  const ifr = document.getElementById('live-preview-iframe');
  if (ifr) ifr.src = ifr.src;  // reassign forces reload
}
function popOutLivePreview() {
  window.open('/storefront?preview=1', '_blank', 'noopener');
  closeDrawer('#live-preview-drawer');
}

// Re-apply language to JS-controlled elements when user toggles language.
window.onLangChange(function () {
  // Re-render dashboard tiles so product names switch language immediately.
  if (typeof bentoRenderAll === 'function') { try { bentoRenderAll(); } catch (e) {} }
  // Re-render the products list so its cuT() labels (overview table header,
  // variant "sizes" meta) follow the toggle without needing a search/filter.
  if (typeof paRender === 'function') { try { paRender(); } catch (e) {} }
  // Leaderboard enabled pill
  if (typeof lbUpdateEnabledPill === 'function') lbUpdateEnabledPill();
  // Flash sale form labels — re-set based on whether an edit is in progress
  const saveLabel = $('#fs-save-label');
  if (saveLabel) {
    const editId = $('#fs-edit-product-id');
    if (editId && editId.value) {
      saveLabel.textContent = cuT('Update flash sale', '更新秒杀');
    } else {
      const formTitle = $('#fs-form-title');
      if (formTitle) formTitle.textContent = cuT('New flash sale', '新建秒杀');
      saveLabel.textContent = cuT('Save flash sale', '保存秒杀');
    }
  }
});



// ?tab= deep-link boot — relocated here from part 01 so the synchronous
// .click() runs AFTER every part has registered its lazy-load tab listener
// (in the old single file it fired before them and deep-linked tabs never
// lazy-loaded; it also kept a cross-file hoisting dependency alive).
// Deep-link: /retail-admin?tab=orders opens that tab directly. Used by the
// new-order push notification so clicking it lands the operator on Orders.
(function () {
  try {
    const want = new URLSearchParams(location.search).get('tab');
    if (!want || !/^[a-z_]+$/.test(want)) return;
    const b = document.querySelector('.tabs [data-tab="' + want + '"]');
    if (b) b.click();
  } catch (e) {}
})();

// ════════════════════════════════════════════════════════════════
// versionWatch — pick up a new build without asking
// The backend shell is served no-store and registers no service worker, so a
// plain reload always pulls fresh JS — but operators keep this tab open for
// hours and otherwise never know a new build shipped. We poll /api/version (a
// token that changes on every deploy / restart) and, once it differs from what
// the page booted with, reload silently — but ONLY at a moment where a reload
// cannot cost the operator anything.
//
// That guard is the whole point. An earlier watcher hard-reloaded on refocus
// and produced "the admin refreshes by itself": an operator halfway through an
// order edit lost the edit and never learned why. So we wait for a safe moment
// — the tab is out of sight, or it has sat untouched for a while — and in
// either case no drawer is open, no field has been typed into, nothing is
// mid-save. If the operator never steps away, we never reload. Sitting on an
// old build is cheap; losing an edit is not.
// ════════════════════════════════════════════════════════════════
(function versionWatch() {
  const IDLE_MS = 10 * 60 * 1000;   // untouched this long = safe to reload in place
  const POLL_MS =  2 * 60 * 1000;

  let bootVersion = null;   // token the page loaded with
  let pending     = false;  // a newer build exists; waiting for a safe moment
  let lastTouch   = Date.now();

  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(ev =>
    document.addEventListener(ev, () => { lastTouch = Date.now(); }, { passive: true, capture: true }));

  async function fetchVersion() {
    try {
      const r = await fetch('/api/version', { cache: 'no-store' }).then(r => r.json());
      return r && r.success ? r.version : null;
    } catch { return null; }
  }

  // Anything on screen the operator could be part-way through.
  function overlayOpen() {
    return !!document.querySelector(
      '.side-drawer.open, .drawer.open, [id$="-drawer"].open, [id$="-scrim"].open, ' +
      '.modal.open, .modal.show, dialog[open]'
    );
  }

  // A field typed into but not saved. defaultValue / defaultChecked hold what the
  // markup (or the last render) put there, so a difference means a human changed it.
  function unsavedEdits() {
    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (el.disabled || el.readOnly || el.type === 'search' || el.type === 'hidden') continue;
      if (el.tagName === 'SELECT') {
        if ([...el.options].some(o => o.selected !== o.defaultSelected)) return true;
      } else if (el.type === 'checkbox' || el.type === 'radio') {
        if (el.checked !== el.defaultChecked) return true;
      } else if (el.value !== el.defaultValue) return true;
    }
    return false;
  }

  function inFlight() {
    return !!document.querySelector('button.busy, .btn.busy, [aria-busy="true"]');
  }

  function safeToReload() {
    const away = document.visibilityState === 'hidden';
    const idle = Date.now() - lastTouch > IDLE_MS;
    if (!away && !idle) return false;
    return !overlayOpen() && !unsavedEdits() && !inFlight();
  }

  function maybeReload() {
    if (pending && safeToReload()) location.reload();
  }

  async function check() {
    const v = await fetchVersion();
    if (!v) return;
    if (bootVersion === null) { bootVersion = v; return; }   // first read = baseline
    if (v !== bootVersion) pending = true;
    maybeReload();
  }

  check();                                // establish baseline on load
  setInterval(check, POLL_MS);
  setInterval(maybeReload, 30 * 1000);    // idle can arrive between polls
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') maybeReload();   // reload behind their back, never under their hands
    else { lastTouch = Date.now(); check(); }
  });
})();

// ════════════════════════════════════════════════════════════════
// QUICK STOCK — the mobile inventory add-on's admin page just hosts the
// on/off switch (injected) plus a "open / copy link" helper. The app itself
// lives at /stock (served on the same origin, self-authenticating).
// ════════════════════════════════════════════════════════════════
function qsStockLink() { return location.origin + '/stock'; }
function qsCopyStockLink() {
  const link = qsStockLink();
  const done = () => toast(cuT('Link copied · 链接已复制', '链接已复制'));
  const fail = () => toast('Copy failed · 复制失败', 'err');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(done, fail);
  } else {
    fail();
  }
}
// Populate the shown link once the DOM is ready (the code elements are static).
// Quick Stock and Add Stock share the same /stock link — the view is chosen by
// the staffer's role, so both cards show the same URL.
(function () {
  function fill() {
    const link = qsStockLink();
    ['qs-link', 'ka-link'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = link; });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fill);
  else fill();
})();
