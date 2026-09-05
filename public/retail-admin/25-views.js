/* eslint-disable no-undef */
/* retail-admin app JS — saved views (audit E-08).

   SAVED VIEWS, FOR ANY SCREEN THAT WANTS THEM
   ═══════════════════════════════════════════════════════════════════════
   "Unpaid orders from the Web channel at the Tianhe shop" had to be rebuilt
   from three controls every morning and could not be handed to a colleague.
   Nothing in the admin remembered a view.

   A screen adopts this by registering two functions and a place to draw:

     viewsRegister({
       screen : 'orders',                     // must match routes/saved-views.js
       mount  : 'ord-views',                  // element id to draw the control in
       read   : () => ({ status:'unpaid' }),  // the filters ON SCREEN right now
       apply  : (q) => { … },                 // put those filters back and reload
     });

   `read` and `apply` are the SCREEN's, deliberately. This module knows nothing
   about what a filter is; it stores whatever the screen hands it under the
   screen's own control names. That is why adopting it is four lines rather than
   a translation layer per screen, and why a screen can grow a control without
   touching this file.

   WHAT IT DOES NOT DO: no default view, and nothing is restored on load. A
   screen that opens showing less than everything, for a reason the operator
   cannot see, produces "where has that order gone" — which is a far worse
   morning than rebuilding a filter. A view applies when somebody picks it. */

const VIEWS_REG = {};          // screen → { screen, mount, read, apply }
const VIEWS_CACHE = {};        // screen → array of views, as the server sent them
let _viewsOpen = null;         // the screen whose menu is open, or null

function viewsRegister(spec) {
  if (!spec || !spec.screen) return;
  VIEWS_REG[spec.screen] = spec;
}
window.viewsRegister = viewsRegister;

const _viewsT = (en, cn) => (typeof cuT === 'function' ? cuT(en, cn) : en);

// Is anything on screen worth saving? Drives the Save item: offering "save this
// view" over the unfiltered list is offering to name the screen.
function _viewsHasFilters(spec) {
  try { return Object.keys(spec.read() || {}).length > 0; } catch (e) { return false; }
}

async function viewsLoad(screen) {
  const spec = VIEWS_REG[screen];
  if (!spec) return;
  try {
    const j = await api('/api/retail-admin/views?screen=' + encodeURIComponent(screen));
    VIEWS_CACHE[screen] = j.data || [];
  } catch (e) {
    // A views control that cannot list is drawn as a control that cannot list.
    // Silently showing an empty menu would read as "you have saved none".
    VIEWS_CACHE[screen] = null;
  }
  viewsPaint(screen);
}
window.viewsLoad = viewsLoad;

function viewsPaint(screen) {
  const spec = VIEWS_REG[screen];
  const box = spec && document.getElementById(spec.mount);
  if (!box) return;
  const list = VIEWS_CACHE[screen];
  const n = Array.isArray(list) ? list.length : 0;
  const open = _viewsOpen === screen;
  const label = _viewsT('Views', '视图') + (n ? ' · ' + n : '');
  box.innerHTML = `
    <div class="vw-wrap${open ? ' open' : ''}">
      <button type="button" class="btn btn-sm vw-btn" onclick="viewsToggle('${screen}')"
              aria-haspopup="true" aria-expanded="${open ? 'true' : 'false'}">${escapeHtml(label)}</button>
      ${open ? _viewsMenuHtml(screen, list, spec) : ''}
    </div>`;
}

function _viewsMenuHtml(screen, list, spec) {
  if (list === null) {
    return `<div class="vw-pop"><div class="vw-empty">${escapeHtml(_viewsT('Could not load your views.', '无法加载视图。'))}
      <button type="button" class="btn btn-sm" onclick="viewsLoad('${screen}')">${escapeHtml(_viewsT('Try again', '重试'))}</button></div></div>`;
  }
  const mine = list.filter((v) => v.mine);
  const theirs = list.filter((v) => !v.mine);
  const row = (v) => `
    <div class="vw-row">
      <button type="button" class="vw-apply" onclick="viewsApply('${screen}', ${v.id})">
        <span data-no-i18n>${escapeHtml(v.name)}</span>
        ${v.shared && !v.mine && v.owner_name
          ? `<span class="vw-by" data-no-i18n>${escapeHtml(_viewsT('shared by', '共享者') + ' ' + v.owner_name)}</span>` : ''}
      </button>
      ${v.mine ? `<button type="button" class="vw-share${v.shared ? ' on' : ''}"
                   title="${escapeHtml(v.shared ? _viewsT('Shared with the team — click to make it yours alone', '已共享 — 点击改为仅自己可见')
                                                : _viewsT('Share with the team', '共享给团队'))}"
                   aria-pressed="${v.shared ? 'true' : 'false'}"
                   onclick="viewsSetShared('${screen}', ${v.id}, ${v.shared ? 'false' : 'true'})">${
                     escapeHtml(v.shared ? _viewsT('Shared', '已共享') : _viewsT('Share', '共享'))}</button>` : ''}
      ${v.mine ? `<button type="button" class="vw-x" title="${escapeHtml(_viewsT('Delete', '删除'))}"
                   aria-label="${escapeHtml(_viewsT('Delete', '删除') + ' ' + v.name)}"
                   onclick="viewsDelete('${screen}', ${v.id})">×</button>` : ''}
    </div>`;
  const empty = `<div class="vw-empty">${escapeHtml(_viewsT('No saved views yet. Filter the list, then save it.', '暂无保存的视图。先筛选列表，再保存。'))}</div>`;
  const can = _viewsHasFilters(spec);
  return `<div class="vw-pop" role="menu">
    ${mine.length ? mine.map(row).join('') : (theirs.length ? '' : empty)}
    ${theirs.length ? `<div class="vw-head">${escapeHtml(_viewsT('Shared with the team', '团队共享'))}</div>${theirs.map(row).join('')}` : ''}
    <div class="vw-foot">
      <button type="button" class="vw-save" onclick="viewsSaveCurrent('${screen}')"${can ? '' : ' disabled'}>
        ${escapeHtml(can ? _viewsT('Save this view…', '保存当前视图…')
                         : _viewsT('Filter the list first', '请先筛选列表'))}
      </button>
    </div>
  </div>`;
}

// Draw the control, but never while its menu is open: the list repaints itself
// on a poll, and rebuilding the menu under somebody's cursor mid-click is how a
// menu appears to ignore them.
function viewsRepaint(screen) {
  if (_viewsOpen === screen) return;
  // The FIRST paint fetches, so the button carries the count before anybody
  // opens it — a "Views" button that might be empty is a button nobody presses.
  // One request per screen per page: viewsLoad always sets the cache, to an
  // array or to null, so this cannot become a retry loop.
  if (VIEWS_REG[screen] && VIEWS_CACHE[screen] === undefined) { viewsLoad(screen); return; }
  viewsPaint(screen);
}
window.viewsRepaint = viewsRepaint;

function viewsToggle(screen) {
  _viewsOpen = _viewsOpen === screen ? null : screen;
  if (_viewsOpen) {
    // Load every time it opens: a colleague may have shared one since the page
    // did, and a stale menu is the failure this feature is supposed to remove.
    viewsLoad(screen);
    setTimeout(() => document.addEventListener('mousedown', _viewsOutside), 0);
  } else {
    document.removeEventListener('mousedown', _viewsOutside);
    viewsPaint(screen);
  }
}
function _viewsOutside(e) {
  if (e.target.closest && e.target.closest('.vw-wrap')) return;
  const screen = _viewsOpen;
  _viewsOpen = null;
  document.removeEventListener('mousedown', _viewsOutside);
  if (screen) viewsPaint(screen);
}
function viewsClose() {
  const screen = _viewsOpen;
  _viewsOpen = null;
  document.removeEventListener('mousedown', _viewsOutside);
  if (screen) viewsPaint(screen);
}
window.viewsToggle = viewsToggle;
window.viewsClose = viewsClose;

function viewsApply(screen, id) {
  const spec = VIEWS_REG[screen];
  const v = (VIEWS_CACHE[screen] || []).find((x) => x.id === id);
  if (!spec || !v) return;
  viewsClose();
  try { spec.apply(v.query || {}); } catch (e) { toast(e.message || 'Failed', 'err'); }
}
window.viewsApply = viewsApply;

async function viewsSaveCurrent(screen) {
  const spec = VIEWS_REG[screen];
  if (!spec) return;
  const query = spec.read() || {};
  if (!Object.keys(query).length) return;
  viewsClose();
  const name = await askPrompt({
    titleEn: 'Name this view', titleCn: '为视图命名',
    subEn: 'It appears on this screen, for you. Share it with the team from the menu afterwards.',
    subCn: '视图将出现在此页面，仅您可见。保存后可在菜单中共享给团队。',
    phEn: 'Unpaid at Tianhe', phCn: '天河店未付款',
    submitEn: 'Save', submitCn: '保存',
  });
  if (name == null || !String(name).trim()) return;
  try {
    await api('/api/retail-admin/views', { method: 'POST', body: { screen, name: String(name).trim(), query } });
    toast(_viewsT('View saved', '视图已保存'), 'ok');
    await viewsLoad(screen);
  } catch (e) {
    toast(_viewsT('Could not save the view', '保存视图失败') + ': ' + (e.message || ''), 'err');
  }
}
window.viewsSaveCurrent = viewsSaveCurrent;

async function viewsDelete(screen, id) {
  const v = (VIEWS_CACHE[screen] || []).find((x) => x.id === id);
  if (!v) return;
  // Confirmed, unlike closing the shop: this one is NOT reversible in a tap —
  // the filters that made it are gone with it, and a shared view takes a
  // colleague's with it too.
  const okToGo = await askConfirm({
    titleEn: 'Delete this view?', titleCn: '删除此视图?',
    bodyEn: v.shared ? `"${v.name}" is shared — it will go for everyone on the team.`
                     : `"${v.name}" will be removed. The filters themselves are not affected.`,
    bodyCn: v.shared ? `“${v.name}” 已共享 — 删除后团队所有人都将失去它。`
                     : `将删除“${v.name}”。当前筛选条件不受影响。`,
    confirmEn: 'Delete', confirmCn: '删除', danger: true,
  });
  if (!okToGo) return;
  try {
    await api('/api/retail-admin/views/' + id, { method: 'DELETE' });
    await viewsLoad(screen);
  } catch (e) {
    toast(_viewsT('Could not delete the view', '删除视图失败') + ': ' + (e.message || ''), 'err');
  }
}
window.viewsDelete = viewsDelete;

// Share / unshare an existing view. Saving keeps a view private; sharing is a
// separate, deliberate act, because the two are different things — a working
// view is scratch, and a shared one is a claim about how the team works.
async function viewsSetShared(screen, id, shared) {
  try {
    await api('/api/retail-admin/views/' + id, { method: 'PATCH', body: { shared: !!shared } });
    toast(shared ? _viewsT('Shared with the team', '已共享给团队')
                 : _viewsT('Yours alone again', '已改为仅自己可见'), 'ok');
    await viewsLoad(screen);
  } catch (e) {
    toast(_viewsT('Could not change sharing', '修改共享设置失败') + ': ' + (e.message || ''), 'err');
  }
}
window.viewsSetShared = viewsSetShared;
